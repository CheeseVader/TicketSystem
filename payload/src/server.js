require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const pool = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}
function allowedDepartment(user) {
  if (!user) return null;
  if (user.role === 'systems') return 'systems';
  if (user.role === 'maintenance') return 'maintenance';
  return null;
}
function canAct(user, department) {
  return user && (user.role === 'superadmin' || allowedDepartment(user) === department);
}

app.get('/', (req, res) => res.redirect('/station/L1-E1'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'views', 'login.html')));
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM users WHERE username=$1 AND active=TRUE', [username]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
    return res.status(401).send('Usuario o contraseña incorrectos. <a href="/login">Regresar</a>');
  }
  req.session.user = { id: user.id, username: user.username, fullName: user.full_name, role: user.role };
  res.redirect('/dashboard');
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/station/:code', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM stations WHERE code=$1 AND enabled=TRUE', [req.params.code.toUpperCase()]);
  if (!rows[0]) return res.status(404).send('Estación no encontrada');
  res.sendFile(path.join(__dirname, '..', 'views', 'station.html'));
});
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(path.join(__dirname, '..', 'views', 'dashboard.html')));

app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));

app.get('/api/categories', async (req, res) => {
  const department = String(req.query.department || '').toLowerCase();
  if (!['systems', 'maintenance'].includes(department)) {
    return res.status(400).json({ error: 'Departamento inválido' });
  }
  const { rows } = await pool.query(
    `SELECT code,label,icon,sort_order
     FROM support_categories
     WHERE department=$1 AND enabled=TRUE
     ORDER BY sort_order,label`,
    [department]
  );
  res.json(rows);
});

app.get('/api/stations/:code', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM stations WHERE code=$1', [req.params.code.toUpperCase()]);
  if (!rows[0]) return res.status(404).json({ error: 'Estación no encontrada' });
  res.json(rows[0]);
});

app.get('/api/stations/:code/requests', async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { rows } = await pool.query(
    `SELECT r.id,r.department,r.category,r.status,r.requested_at,r.attended_at,
            u.full_name AS attended_by_name, c.label AS category_label, c.icon AS category_icon
     FROM support_requests r
     JOIN stations s ON s.id=r.station_id
     LEFT JOIN users u ON u.id=r.attended_by
     LEFT JOIN support_categories c ON c.department=r.department AND c.code=r.category
     WHERE s.code=$1 AND r.status IN ('requested','attending')
     ORDER BY r.requested_at`,
    [code]
  );
  res.json(rows);
});

app.post('/api/requests', async (req, res) => {
  const { stationCode, department, category, requestedBy, notes } = req.body;
  if (!['systems','maintenance'].includes(department)) return res.status(400).json({ error: 'Departamento inválido' });
  if (!category) return res.status(400).json({ error: 'Selecciona una categoría.' });

  try {
    const validCategory = await pool.query(
      `SELECT code,label FROM support_categories
       WHERE department=$1 AND code=$2 AND enabled=TRUE`,
      [department, String(category).toLowerCase()]
    );
    if (!validCategory.rows[0]) return res.status(400).json({ error: 'Categoría inválida para esta área.' });

    const st = await pool.query('SELECT id,code,line_no,station_no FROM stations WHERE code=$1 AND enabled=TRUE', [String(stationCode).toUpperCase()]);
    if (!st.rows[0]) return res.status(404).json({ error: 'Estación no encontrada' });

    // Compatibilidad con solicitudes creadas por versiones antiguas sin categoría.
    // Si existe una activa con category NULL, la completamos en vez de bloquear al operador.
    const legacyActive = await pool.query(
      `SELECT id,category FROM support_requests
       WHERE station_id=$1 AND department=$2 AND status IN ('requested','attending')
       ORDER BY requested_at DESC LIMIT 1`,
      [st.rows[0].id, department]
    );
    if (legacyActive.rows[0]) {
      if (!legacyActive.rows[0].category) {
        const updated = await pool.query(
          `UPDATE support_requests
           SET category=$1, notes=COALESCE(NULLIF($2,''),notes), requested_by=COALESCE(NULLIF($3,''),requested_by)
           WHERE id=$4 RETURNING *`,
          [String(category).toLowerCase(), notes || '', requestedBy || '', legacyActive.rows[0].id]
        );
        io.emit('request:changed', {
          action: 'categorized', id: updated.rows[0].id, stationCode: st.rows[0].code,
          department, category: String(category).toLowerCase()
        });
        return res.status(200).json(updated.rows[0]);
      }
      return res.status(409).json({ error: `Ya existe una solicitud activa de ${department === 'systems' ? 'Sistemas' : 'Mantenimiento'} para esta estación.` });
    }

    const result = await pool.query(
      `INSERT INTO support_requests(station_id,department,category,requested_by,notes)
       VALUES($1,$2,$3,$4,$5)
       RETURNING *`,
      [st.rows[0].id, department, String(category).toLowerCase(), requestedBy || 'Operador', notes || null]
    );

    io.emit('request:changed', {
      action: 'created',
      id: result.rows[0].id,
      stationCode: st.rows[0].code,
      department,
      category: String(category).toLowerCase()
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe una solicitud activa de esta área para esta estación.' });
    console.error(err);
    res.status(500).json({ error: 'No se pudo crear la solicitud' });
  }
});

app.get('/api/dashboard', requireAuth, async (req, res) => {
  const user = req.session.user;
  const dept = allowedDepartment(user);
  const params = [];
  let filter = '';
  if (dept) { params.push(dept); filter = `WHERE r.department=$1`; }

  const stations = await pool.query('SELECT * FROM stations WHERE enabled=TRUE ORDER BY line_no,station_no');
  const active = await pool.query(
    `SELECT r.*, s.code, s.line_no, s.station_no, u.full_name AS attended_by_name,
            c.label AS category_label, c.icon AS category_icon
     FROM support_requests r
     JOIN stations s ON s.id=r.station_id
     LEFT JOIN users u ON u.id=r.attended_by
     LEFT JOIN support_categories c ON c.department=r.department AND c.code=r.category
     ${filter ? filter + " AND r.status IN ('requested','attending')" : "WHERE r.status IN ('requested','attending')"}
     ORDER BY r.requested_at ASC`, params);

  const recent = await pool.query(
    `SELECT r.*, s.code, u.full_name AS attended_by_name, ur.full_name AS resolved_by_name,
            c.label AS category_label, c.icon AS category_icon
     FROM support_requests r
     JOIN stations s ON s.id=r.station_id
     LEFT JOIN users u ON u.id=r.attended_by
     LEFT JOIN users ur ON ur.id=r.resolved_by
     LEFT JOIN support_categories c ON c.department=r.department AND c.code=r.category
     ${filter}
     ORDER BY r.requested_at DESC LIMIT 20`, params);

  const today = await pool.query(
    `SELECT COUNT(*)::int AS count FROM support_requests r
     WHERE r.status='resolved' AND r.resolved_at::date=CURRENT_DATE ${dept ? 'AND r.department=$1' : ''}`, params);

  res.json({ user, stations: stations.rows, active: active.rows, recent: recent.rows, attendedToday: today.rows[0].count });
});

app.post('/api/requests/:id/attend', requireAuth, async (req, res) => {
  const check = await pool.query(
    `SELECT r.*,s.code AS station_code FROM support_requests r JOIN stations s ON s.id=r.station_id WHERE r.id=$1`,
    [req.params.id]
  );
  const r = check.rows[0];
  if (!r) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (!canAct(req.session.user, r.department)) return res.status(403).json({ error: 'No autorizado para esta área' });
  if (r.status !== 'requested') return res.status(409).json({ error: 'La solicitud ya fue tomada o cerrada' });

  const q = await pool.query(
    `UPDATE support_requests SET status='attending', attended_at=NOW(), attended_by=$1 WHERE id=$2 RETURNING *`,
    [req.session.user.id, req.params.id]
  );
  io.emit('request:changed', { action: 'attending', id: Number(req.params.id), stationCode: r.station_code, department: r.department, category: r.category });
  res.json(q.rows[0]);
});

app.post('/api/requests/:id/resolve', requireAuth, async (req, res) => {
  const check = await pool.query(
    `SELECT r.*,s.code AS station_code FROM support_requests r JOIN stations s ON s.id=r.station_id WHERE r.id=$1`,
    [req.params.id]
  );
  const r = check.rows[0];
  if (!r) return res.status(404).json({ error: 'Solicitud no encontrada' });
  if (!canAct(req.session.user, r.department)) return res.status(403).json({ error: 'No autorizado para esta área' });
  if (r.status === 'resolved') return res.status(409).json({ error: 'La solicitud ya está resuelta' });

  const q = await pool.query(
    `UPDATE support_requests
     SET status='resolved', resolved_at=NOW(), resolved_by=$1,
         attended_at=COALESCE(attended_at,NOW()), attended_by=COALESCE(attended_by,$1)
     WHERE id=$2 RETURNING *`,
    [req.session.user.id, req.params.id]
  );
  io.emit('request:changed', { action: 'resolved', id: Number(req.params.id), stationCode: r.station_code, department: r.department, category: r.category });
  res.json(q.rows[0]);
});

io.on('connection', socket => socket.emit('connected', { ok: true }));

server.listen(PORT, HOST, () => {
  console.log(`Andon Support ejecutándose en http://localhost:${PORT}`);
  console.log(`Client example: http://localhost:${PORT}/station/L1-E1`);
  console.log(`Dashboard: http://localhost:${PORT}/login`);
});
