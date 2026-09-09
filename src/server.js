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
const APP_BUILD = 'R10.8.3';
const BOOT_ID = `${Date.now()}-${Math.random().toString(36).slice(2,10)}`;

app.use(helmet({ contentSecurityPolicy: false }));
app.use((req,res,next)=>{
  if (req.path.startsWith('/station/') || req.path === '/soporte' || req.path === '/dashboard' || req.path === '/login' || /\.(js|css|html)$/.test(req.path)) {
    res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma','no-cache');
    res.set('Expires','0');
  }
  next();
});
app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:false}));
app.use(express.static(path.join(__dirname,'..','public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  resave:false,
  saveUninitialized:false,
  cookie:{httpOnly:true,sameSite:'lax',maxAge:8*60*60*1000}
}));

const ACTIVE_TICKET_STATUSES = ['assigned','in_progress','waiting','escalated','resolved'];
const HISTORY_STATUSES = ['closed','cancelled'];
const OPEN_REQUEST_STATUSES = ['unassigned','assigned','in_progress','waiting','escalated','resolved'];

function requireAuth(req,res,next){
  if(!req.session.user) return req.path.startsWith('/api/') ? res.status(401).json({error:'No autenticado'}) : res.redirect('/login');
  next();
}
function isManager(user){ return user && ['superadmin','admin'].includes(user.role); }
function requireManager(req,res,next){
  if(!req.session.user) return res.status(401).json({error:'No autenticado'});
  if(!isManager(req.session.user)) return res.status(403).json({error:'SÃ³lo Administradores'});
  next();
}
function requireSuperadmin(req,res,next){
  if(!req.session.user) return res.status(401).json({error:'No autenticado'});
  if(req.session.user.role!=='superadmin') return res.status(403).json({error:'SÃ³lo Superadmin'});
  next();
}
function userDepartment(user){ return user?.role==='engineer' ? user.department : null; }
function canAct(user,department){ return !!user && (isManager(user) || (user.role==='engineer' && user.department===department)); }
function deptWhere(user,alias='r',index=1){
  const d=userDepartment(user);
  return d ? {sql:`${alias}.department=$${index}`,params:[d]} : {sql:'',params:[]};
}
function slug(value){
  return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().trim()
    .replace(/[^A-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').replace(/-+/g,'-').slice(0,60);
}
function stationCodeFromNames(groupName,stationName){
  const g=slug(groupName), n=slug(stationName);
  if(!g||!n)return '';
  return `${g}-${n}`.slice(0,80);
}
function cleanStationLabel(label,groupName){
  const raw=String(label||'').trim();
  const gp=slug(groupName), sr=slug(raw);
  if(gp && sr.startsWith(gp+'-')) return sr.slice(gp.length+1)||raw;
  return raw;
}
function ticketStateLabel(s){
  return ({assigned:'Asignado',in_progress:'En progreso',waiting:'En espera',escalated:'Escalado',resolved:'Resuelto',closed:'Cerrado',cancelled:'Cancelado'})[s]||s;
}
async function resolveStation(code){
  const normalized=String(code||'').toUpperCase();
  let q=await pool.query(`SELECT s.*,g.code group_code,g.name group_name,g.enabled group_enabled FROM stations s LEFT JOIN production_groups g ON g.id=s.group_id WHERE s.code=$1`,[normalized]);
  if(q.rows[0]) return {station:q.rows[0],alias:false};
  q=await pool.query(`SELECT s.*,g.code group_code,g.name group_name,g.enabled group_enabled,a.old_code FROM station_aliases a JOIN stations s ON s.id=a.station_id LEFT JOIN production_groups g ON g.id=s.group_id WHERE a.old_code=$1`,[normalized]);
  return q.rows[0] ? {station:q.rows[0],alias:true} : null;
}
async function pickSla(department,category,stationId=null,client=pool){
  const {rows}=await client.query(`
    SELECT sp.* FROM sla_policies sp
    WHERE sp.enabled=TRUE
      AND (sp.department IS NULL OR sp.department=$1)
      AND (sp.category IS NULL OR sp.category=$2)
      AND (sp.station_id IS NULL OR sp.station_id=$3)
      AND (sp.group_id IS NULL OR sp.group_id=(SELECT group_id FROM stations WHERE id=$3))
    ORDER BY
      CASE WHEN sp.station_id=$3 THEN 1 WHEN sp.group_id=(SELECT group_id FROM stations WHERE id=$3) THEN 2 ELSE 3 END,
      CASE WHEN sp.department=$1 AND sp.category=$2 THEN 1 WHEN sp.department=$1 AND sp.category IS NULL THEN 2 WHEN sp.department IS NULL AND sp.category IS NULL THEN 3 ELSE 4 END,
      sp.priority,sp.id
    LIMIT 1`,[department,category,stationId]);
  return rows[0]||null;
}
async function logTicketEvent(client,ticketId,eventType,oldStatus,newStatus,userId,comment){
  await client.query(`INSERT INTO ticket_events(ticket_id,event_type,old_status,new_status,user_id,comment) VALUES($1,$2,$3,$4,$5,$6)`,[ticketId,eventType,oldStatus||null,newStatus||null,userId||null,comment||null]);
}
async function ticketSnapshot(id,client=pool){
  const {rows}=await client.query(`
    SELECT t.*,r.requested_at,r.requested_by,r.notes request_notes,r.status request_status,r.attended_at,
           u.full_name assigned_to_name,ur.full_name resolved_by_name,
           s.name sla_name,s.response_minutes,s.resolution_minutes,s.autoclose_minutes,s.pause_on_waiting,
           COALESCE(t.assigned_at,r.attended_at) actual_response_at,
           CASE WHEN COALESCE(t.assigned_at,r.attended_at) IS NOT NULL
                THEN GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(t.assigned_at,r.attended_at)-r.requested_at))::bigint) END response_seconds,
           CASE WHEN t.resolved_at IS NOT NULL
                THEN GREATEST(0,EXTRACT(EPOCH FROM (t.resolved_at-r.requested_at))::bigint) END resolution_seconds,
           CASE WHEN COALESCE(t.assigned_at,r.attended_at) IS NULL OR t.response_due_at IS NULL THEN NULL
                ELSE COALESCE(t.assigned_at,r.attended_at) <= t.response_due_at END response_sla_met,
           CASE WHEN t.resolved_at IS NULL OR t.resolution_due_at IS NULL THEN NULL
                ELSE t.resolved_at <= t.resolution_due_at END resolution_sla_met
    FROM tickets t JOIN support_requests r ON r.id=t.request_id
    LEFT JOIN users u ON u.id=t.assigned_to LEFT JOIN users ur ON ur.id=t.resolved_by
    LEFT JOIN sla_policies s ON s.id=t.sla_policy_id WHERE t.id=$1`,[id]);
  return rows[0]||null;
}

app.get('/',(req,res)=>res.redirect('/station/L1-E1'));
app.get('/login',(req,res)=>res.sendFile(path.join(__dirname,'..','views','login.html')));
app.post('/login',async(req,res)=>{
  const username=String(req.body.username||'').trim();
  const {rows}=await pool.query(`SELECT * FROM users WHERE username=$1 AND active=TRUE AND deleted_at IS NULL`,[username]);
  const user=rows[0];
  if(!user || !(await bcrypt.compare(String(req.body.password||''),user.password_hash))) return res.status(401).send('Usuario o contraseÃ±a incorrectos. <a href="/login">Regresar</a>');
  req.session.user={id:user.id,username:user.username,fullName:user.full_name,role:user.role,department:user.department||null};
  res.redirect('/dashboard');
});
app.post('/logout',(req,res)=>req.session.destroy(()=>res.redirect('/login')));
app.get('/station/:code',async(req,res)=>{
  const found=await resolveStation(req.params.code);
  if(!found || !found.station.enabled || found.station.group_enabled===false) return res.status(404).send('EstaciÃ³n no encontrada');
  if(found.alias) return res.redirect(302,`/station/${found.station.code}`);
  res.sendFile(path.join(__dirname,'..','views','station.html'));
});
app.get('/dashboard',requireAuth,(req,res)=>res.sendFile(path.join(__dirname,'..','views','dashboard.html')));
app.get('/soporte',(req,res)=>res.sendFile(path.join(__dirname,'..','views','soporte.html'))); // ANDON SOPORTE R1

app.get('/api/build',(req,res)=>res.json({build:APP_BUILD,bootId:BOOT_ID,serverTime:new Date().toISOString()}));
app.get('/api/me',(req,res)=>res.json({user:req.session.user||null}));

// ============================================================
// ANDON SOPORTE R1 - PORTAL ADMINISTRATIVO
// ============================================================
app.get('/api/soporte/catalog',async(req,res)=>{
  try{
    const [areas,groups,requests]=await Promise.all([
      pool.query(`SELECT name FROM support_areas WHERE enabled=TRUE ORDER BY sort_order,name`),
      pool.query(`SELECT name FROM production_groups WHERE enabled=TRUE AND archived_at IS NULL ORDER BY sort_order,name`),
      pool.query(`SELECT department,code,label,category_group FROM admin_support_requests_catalog WHERE enabled=TRUE ORDER BY department,sort_order,label`)
    ]);

    // Ubicacion = Areas/Departamentos + Lineas/Grupos.
    // No incluir estaciones individuales (INPUT, PACKING, ESCANEO, etc.).
    const locationMap=new Map();

    for(const item of [...areas.rows,...groups.rows]){
      const name=String(item.name||'').trim();
      if(!name) continue;

      const key=name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g,'')
        .toUpperCase();

      if(!locationMap.has(key)){
        locationMap.set(key,{name});
      }
    }

    res.json({
      areas:areas.rows,
      locations:[...locationMap.values()],
      requests:requests.rows
    });
  }catch(e){
    console.error('soporte catalog',e);
    res.status(500).json({error:'No se pudo cargar el catalogo de soporte'});
  }
});

app.post('/api/soporte/requests',async(req,res)=>{
  try{
    const requesterName=String(req.body.requesterName||'').trim().slice(0,100);
    const requesterArea=String(req.body.requesterArea||'').trim().slice(0,100);
    const supportLocation=String(req.body.supportLocation||'').trim().slice(0,160);
    const department=String(req.body.department||'').toLowerCase();
    const requestType=String(req.body.requestType||'').toLowerCase();
    const description=String(req.body.description||'').trim().slice(0,500);
    if(!requesterName||!requesterArea||!supportLocation)return res.status(400).json({error:'Nombre, area y ubicacion son requeridos.'});
    if(!['systems','maintenance'].includes(department))return res.status(400).json({error:'Departamento invalido.'});
    const cat=(await pool.query(`SELECT code,label FROM admin_support_requests_catalog WHERE department=$1 AND code=$2 AND enabled=TRUE`,[department,requestType])).rows[0];
    if(!cat)return res.status(400).json({error:'Peticion invalida.'});
    if(!description)return res.status(400).json({error:'Agrega una descripción breve del problema.'});

    const station=(await pool.query(`SELECT s.id,s.code FROM stations s LEFT JOIN production_groups g ON g.id=s.group_id WHERE s.enabled=TRUE AND COALESCE(g.enabled,TRUE)=TRUE AND (UPPER(s.code)=UPPER($1) OR UPPER(COALESCE(g.name,'')||' - '||s.label)=UPPER($1)) LIMIT 1`,[supportLocation])).rows[0]||null;
    const sla=await pickSla(department,requestType,station?.id||null);
    const notes=description;
    const q=(await pool.query(`INSERT INTO support_requests(station_id,department,category,status,requested_by,notes,sla_policy_id,source,requester_area,support_location,admin_request_type) VALUES($1,$2,$3,'unassigned',$4,$5,$6,'administrative',$7,$8,$9) RETURNING *`,[station?.id||null,department,requestType,requesterName,notes,sla?.id||null,requesterArea,supportLocation,requestType])).rows[0];
    io.emit('request:changed',{action:'created',id:q.id,stationCode:supportLocation,department,category:requestType,category_label:cat.label,source:'administrative',requesterArea,requester_area:requesterArea,supportLocation,support_location:supportLocation});
    res.status(201).json({...q,department_label:department==='systems'?'Sistemas':'Mantenimiento',request_label:cat.label});
  }catch(e){console.error('soporte request',e);res.status(500).json({error:`No se pudo crear la solicitud${e.code?' ('+e.code+')':''}`});}
});
app.get('/api/categories',async(req,res)=>{
  const department=String(req.query.department||'').toLowerCase();
  if(!['systems','maintenance'].includes(department)) return res.status(400).json({error:'Departamento invÃ¡lido'});
  const {rows}=await pool.query(`SELECT code,label,icon,sort_order FROM support_categories WHERE department=$1 AND enabled=TRUE ORDER BY sort_order,label`,[department]);
  res.json(rows);
});

app.get('/api/stations/:code',async(req,res)=>{
  const found=await resolveStation(req.params.code);
  if(!found) return res.status(404).json({error:'EstaciÃ³n no encontrada'});
  res.json(found.station);
});

app.get('/api/stations/:code/requests',async(req,res)=>{
  const found=await resolveStation(req.params.code);
  if(!found) return res.status(404).json({error:'EstaciÃ³n no encontrada'});
  const {rows}=await pool.query(`
    SELECT r.id,r.department,r.category,r.status,r.requested_at,r.assigned_at,r.attended_at,r.resolved_at,r.notes,
           t.id ticket_id,t.ticket_number,t.status ticket_status,t.assigned_to,t.auto_close_at,
           u.full_name attended_by_name,COALESCE(ac.label,c.label,r.category) category_label,c.icon category_icon
    FROM support_requests r
    LEFT JOIN tickets t ON t.request_id=r.id
    LEFT JOIN users u ON u.id=t.assigned_to
    LEFT JOIN support_categories c ON c.department=r.department AND c.code=r.category LEFT JOIN admin_support_requests_catalog ac ON ac.department=r.department AND ac.code=r.category
    WHERE r.station_id=$1 AND r.status = ANY($2::text[])
    ORDER BY r.requested_at`,[found.station.id,OPEN_REQUEST_STATUSES]);
  res.json(rows.map(x=>({...x,status:x.ticket_status||x.status})));
});

app.post('/api/requests',async(req,res)=>{
  const {stationCode,department,category,requestedBy,notes}=req.body;
  if(!['systems','maintenance'].includes(department)) return res.status(400).json({error:'Departamento invÃ¡lido'});
  if(!category) return res.status(400).json({error:'Selecciona una categorÃ­a.'});
  const normalizedCategory=String(category).toLowerCase();
  const cleanNotes=String(notes||'').trim().slice(0,500);
  const found=await resolveStation(stationCode);
  if(!found || !found.station.enabled) return res.status(404).json({error:'EstaciÃ³n no encontrada'});
  const valid=(await pool.query(`SELECT code,label,icon FROM support_categories WHERE department=$1 AND code=$2 AND enabled=TRUE`,[department,normalizedCategory])).rows[0];
  if(!valid) return res.status(400).json({error:'CategorÃ­a invÃ¡lida para esta Ã¡rea.'});

  // Bloquear sÃ³lo mientras exista una incidencia ACTIVA; una resuelta permite un nuevo evento independiente.
  const active=(await pool.query(`SELECT id,status FROM support_requests WHERE station_id=$1 AND department=$2 AND status IN ('unassigned','assigned','in_progress','waiting','escalated') ORDER BY requested_at DESC LIMIT 1`,[found.station.id,department])).rows[0];
  if(active) return res.status(409).json({error:'Ya existe una incidencia activa de esta Ã¡rea para este equipo.'});

  const sla=await pickSla(department,normalizedCategory,found.station.id);
  const q=await pool.query(`INSERT INTO support_requests(station_id,department,category,status,requested_by,notes,sla_policy_id) VALUES($1,$2,$3,'unassigned',$4,$5,$6) RETURNING *`,[found.station.id,department,normalizedCategory,requestedBy||'Operador de estaciÃ³n',cleanNotes||null,sla?.id||null]);
  io.emit('request:changed',{action:'created',id:q.rows[0].id,stationCode:found.station.code,department,category:normalizedCategory});
  res.status(201).json({...q.rows[0],category_label:valid.label,category_icon:valid.icon});
});

// ============================================================
// DASHBOARD / POOL DE SOLICITUDES
// ============================================================
app.get('/api/dashboard',requireAuth,async(req,res)=>{
  const user=req.session.user;
  const dept=userDepartment(user);
  const params=dept?[dept]:[];
  const deptCond=dept?`AND r.department=$1`:'';
  const groups=await pool.query(`SELECT id,code,name,sort_order,enabled FROM production_groups WHERE enabled=TRUE AND archived_at IS NULL ORDER BY sort_order,name`);
  const stations=await pool.query(`SELECT s.id,s.code,s.label,s.enabled,s.group_id,s.station_no,g.name group_name,g.code group_code FROM stations s LEFT JOIN production_groups g ON g.id=s.group_id WHERE s.enabled=TRUE AND s.archived_at IS NULL AND COALESCE(g.enabled,TRUE)=TRUE ORDER BY g.sort_order,s.station_no,s.code`);
  const open=await pool.query(`
    SELECT r.*,s.code,s.label station_name,s.group_id,g.name group_name,g.code group_code,COALESCE(ac.label,c.label,r.category) category_label,c.icon category_icon,
           t.id ticket_id,t.ticket_number,t.status ticket_status,t.assigned_to,u.full_name assigned_to_name,
           COALESCE(t.response_due_at, r.requested_at + make_interval(mins=>COALESCE(sp.response_minutes,5))) response_due_at,
           COALESCE(t.resolution_due_at, r.requested_at + make_interval(mins=>COALESCE(sp.resolution_minutes,60))) resolution_due_at,
           t.auto_close_at,sp.response_minutes,sp.resolution_minutes,sp.name sla_name
    FROM support_requests r LEFT JOIN stations s ON s.id=r.station_id LEFT JOIN production_groups g ON g.id=s.group_id
    LEFT JOIN support_categories c ON c.department=r.department AND c.code=r.category LEFT JOIN admin_support_requests_catalog ac ON ac.department=r.department AND ac.code=r.category
    LEFT JOIN sla_policies sp ON sp.id=r.sla_policy_id
    LEFT JOIN tickets t ON t.request_id=r.id LEFT JOIN users u ON u.id=t.assigned_to
    WHERE r.status IN ('unassigned','assigned','in_progress','waiting','escalated','resolved') ${deptCond}
    ORDER BY r.requested_at`,params);
  const recent=await pool.query(`
    SELECT r.id,r.department,r.category,r.status,r.requested_at,r.resolved_at,r.closed_at,r.notes,s.code,s.label station_name,g.name group_name,
           COALESCE(ac.label,c.label,r.category) category_label,t.ticket_number,t.status ticket_status,u.full_name assigned_to_name
    FROM support_requests r LEFT JOIN stations s ON s.id=r.station_id LEFT JOIN production_groups g ON g.id=s.group_id
    LEFT JOIN support_categories c ON c.department=r.department AND c.code=r.category LEFT JOIN admin_support_requests_catalog ac ON ac.department=r.department AND ac.code=r.category LEFT JOIN tickets t ON t.request_id=r.id LEFT JOIN users u ON u.id=t.assigned_to
    WHERE 1=1 ${deptCond} ORDER BY r.requested_at DESC LIMIT 25`,params);
  const today=(await pool.query(`SELECT COUNT(*)::int count FROM support_requests r WHERE r.closed_at::date=CURRENT_DATE ${deptCond}`,params)).rows[0].count;
  const slaBreached=(await pool.query(`
    SELECT COUNT(*)::int count
    FROM support_requests r
    LEFT JOIN tickets t ON t.request_id=r.id
    LEFT JOIN sla_policies sp ON sp.id=COALESCE(t.sla_policy_id,r.sla_policy_id)
    WHERE r.status IN ('unassigned','assigned','in_progress','waiting','escalated','resolved')
      ${dept?`AND r.department=$1`:''}
      AND (
        (r.status='unassigned' AND NOW() > r.requested_at + make_interval(mins=>COALESCE(sp.response_minutes,5)))
        OR
        (t.id IS NOT NULL AND t.status NOT IN ('resolved','closed','cancelled') AND t.resolution_due_at IS NOT NULL AND NOW()>t.resolution_due_at)
      )`,params)).rows[0].count;
  res.json({user,groups:groups.rows,stations:stations.rows,open:open.rows,recent:recent.rows,closedToday:today,slaBreached});
});

app.get('/api/requests-list',requireAuth,async(req,res)=>{
  const user=req.session.user;
  const dept=userDepartment(user);
  const params=dept?[dept]:[];
  const whereDept=dept?`AND r.department=$1`:'';
  // Solicitudes = sÃ³lo pool SIN ASIGNAR.
  const {rows}=await pool.query(`
    SELECT r.*,s.code,s.label station_name,g.name group_name,g.code group_code,COALESCE(ac.label,c.label,r.category) category_label,c.icon category_icon,
           sp.name sla_name,COALESCE(sp.response_minutes,5) response_minutes,COALESCE(sp.resolution_minutes,60) resolution_minutes,
           r.requested_at + make_interval(mins=>COALESCE(sp.response_minutes,5)) response_due_at
    FROM support_requests r LEFT JOIN stations s ON s.id=r.station_id LEFT JOIN production_groups g ON g.id=s.group_id
    LEFT JOIN support_categories c ON c.department=r.department AND c.code=r.category LEFT JOIN admin_support_requests_catalog ac ON ac.department=r.department AND ac.code=r.category LEFT JOIN sla_policies sp ON sp.id=r.sla_policy_id
    WHERE r.status='unassigned' ${whereDept} ORDER BY r.requested_at ASC`,params);
  res.json(rows);
});

app.post('/api/requests/:id/assign',requireAuth,async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');

    const check=(await client.query(`
      SELECT r.*,COALESCE(s.code,'SOPORTE-'||r.id::text) station_code,COALESCE(s.label,r.support_location,'Soporte administrativo') station_name,COALESCE(g.name,r.requester_area,'Administrativo') group_name,COALESCE(ac.label,c.label,r.category) category_label
      FROM support_requests r
      LEFT JOIN stations s ON s.id=r.station_id
      LEFT JOIN production_groups g ON g.id=s.group_id
      LEFT JOIN support_categories c ON c.department=r.department AND c.code=r.category LEFT JOIN admin_support_requests_catalog ac ON ac.department=r.department AND ac.code=r.category
      WHERE r.id=$1
      FOR UPDATE OF r`,[req.params.id])).rows[0];

    if(!check){await client.query('ROLLBACK');return res.status(404).json({error:'Solicitud no encontrada'});}
    if(!canAct(req.session.user,check.department)){await client.query('ROLLBACK');return res.status(403).json({error:'No autorizado para esta Ã¡rea'});}
    if(check.status!=='unassigned'){await client.query('ROLLBACK');return res.status(409).json({error:'La solicitud ya fue asignada'});}

    const sla=check.sla_policy_id
      ? (await client.query(`SELECT * FROM sla_policies WHERE id=$1 AND enabled=TRUE`,[check.sla_policy_id])).rows[0]
      : await pickSla(check.department,check.category,check.station_id,client);

    const responseMinutes=Number(sla?.response_minutes||5);
    const resolutionMinutes=Number(sla?.resolution_minutes||60);
    const requestedAt=new Date(check.requested_at);
    const responseDueAt=new Date(requestedAt.getTime()+responseMinutes*60000);
    const resolutionDueAt=new Date(requestedAt.getTime()+resolutionMinutes*60000);

    const rq=(await client.query(`
      UPDATE support_requests
      SET status='assigned',assigned_at=NOW(),attended_at=NOW(),attended_by=$1,
          sla_policy_id=COALESCE($2,sla_policy_id),updated_at=NOW()
      WHERE id=$3
      RETURNING *`,
      [req.session.user.id,sla?.id||null,check.id])).rows[0];

    let t=(await client.query(`SELECT * FROM tickets WHERE request_id=$1 FOR UPDATE`,[check.id])).rows[0];

    if(t){
      t=(await client.query(`
        UPDATE tickets SET
          department=$1,station_code=$2,station_name=$3,group_name=$4,category=$5,category_label=$6,description=$7,
          assigned_to=$8,assigned_at=NOW(),status='assigned',sla_policy_id=$9,
          response_due_at=$10,resolution_due_at=$11,resolved_at=NULL,resolved_by=NULL,
          auto_close_at=NULL,closed_at=NULL,closure_type=NULL,updated_at=NOW()
        WHERE id=$12 RETURNING *`,
        [check.department,check.station_code,check.station_name,check.group_name,check.category,check.category_label,check.notes,
         req.session.user.id,sla?.id||null,responseDueAt,resolutionDueAt,t.id])).rows[0];
    }else{
      t=(await client.query(`
        INSERT INTO tickets(
          request_id,department,station_code,station_name,group_name,category,category_label,description,
          assigned_to,assigned_at,status,sla_policy_id,response_due_at,resolution_due_at,created_at,updated_at
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),'assigned',$10,$11,$12,NOW(),NOW())
        RETURNING *`,
        [check.id,check.department,check.station_code,check.station_name,check.group_name,check.category,check.category_label,
         check.notes,req.session.user.id,sla?.id||null,responseDueAt,resolutionDueAt])).rows[0];
    }

    if(!t.ticket_number){
      const prefix=check.department==='systems'?'SYS':'MNT';
      const datePart=new Date().toISOString().slice(0,10).replace(/-/g,'');
      t=(await client.query(`UPDATE tickets SET ticket_number=$1 WHERE id=$2 RETURNING *`,
        [`${prefix}-${datePart}-${String(t.id).padStart(6,'0')}`,t.id])).rows[0];
    }

    await logTicketEvent(client,t.id,'assigned',null,'assigned',req.session.user.id,'Solicitud tomada del pool');
    await client.query('COMMIT');

    io.emit('request:changed',{action:'assigned',id:check.id,stationCode:check.station_code,department:check.department,ticketNumber:t.ticket_number});
    io.emit('ticket:changed',{action:'created',ticketId:t.id,ticketNumber:t.ticket_number,department:t.department});
    res.json({request:rq,ticket:t});
  }catch(e){
    try{await client.query('ROLLBACK')}catch{}
    console.error('R10.5 assign request:',e);
    res.status(500).json({error:`No se pudo asignar la solicitud${e.code?' ('+e.code+')':''}`});
  }finally{client.release();}
});

// ============================================================
// TICKETS ACTIVOS / ESTADOS
// ============================================================
app.get('/api/tickets',requireAuth,async(req,res)=>{
  const user=req.session.user; const dept=userDepartment(user); const params=[]; const cond=[];
  params.push(ACTIVE_TICKET_STATUSES); cond.push(`t.status = ANY($1::text[])`);
  if(dept){params.push(dept);cond.push(`t.department=$${params.length}`);}
  if(user.role==='engineer' && String(req.query.mine||'0')==='1'){params.push(user.id);cond.push(`t.assigned_to=$${params.length}`);}
  const {rows}=await pool.query(`
    SELECT t.*,r.requested_at,r.requested_by,r.notes request_notes,u.full_name assigned_to_name,ur.full_name resolved_by_name,
           sp.name sla_name,sp.response_minutes,sp.resolution_minutes,sp.autoclose_minutes,sp.pause_on_waiting
    FROM tickets t JOIN support_requests r ON r.id=t.request_id LEFT JOIN users u ON u.id=t.assigned_to LEFT JOIN users ur ON ur.id=t.resolved_by LEFT JOIN sla_policies sp ON sp.id=t.sla_policy_id
    WHERE ${cond.join(' AND ')} ORDER BY CASE t.status WHEN 'escalated' THEN 1 WHEN 'waiting' THEN 2 WHEN 'in_progress' THEN 3 WHEN 'assigned' THEN 4 WHEN 'resolved' THEN 5 ELSE 9 END,t.updated_at DESC`,params);
  res.json(rows);
});

app.get('/api/tickets/:id/events',requireAuth,async(req,res)=>{
  const t=await ticketSnapshot(req.params.id); if(!t)return res.status(404).json({error:'Ticket no encontrado'});
  if(!canAct(req.session.user,t.department) && req.session.user.role==='engineer')return res.status(403).json({error:'No autorizado'});
  const {rows}=await pool.query(`SELECT e.*,u.full_name user_name FROM ticket_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.ticket_id=$1 ORDER BY e.created_at`,[req.params.id]);
  res.json({ticket:t,events:rows});
});

app.patch('/api/tickets/:id/status',requireAuth,async(req,res)=>{
  const desired=String(req.body.status||'').trim();
  const allowed=['assigned','in_progress','waiting','escalated','resolved','closed'];
  if(!allowed.includes(desired))return res.status(400).json({error:'Estado invÃ¡lido'});

  const client=await pool.connect();
  try{
    await client.query('BEGIN');

    const t=(await client.query(`
      SELECT t.*,r.requested_at,r.station_id,s.code station_current_code,
             COALESCE(sp.autoclose_minutes,10) autoclose_minutes,
             COALESCE(sp.pause_on_waiting,TRUE) pause_on_waiting
      FROM tickets t
      JOIN support_requests r ON r.id=t.request_id
      LEFT JOIN stations s ON s.id=r.station_id
      LEFT JOIN sla_policies sp ON sp.id=t.sla_policy_id
      WHERE t.id=$1
      FOR UPDATE OF t`,[req.params.id])).rows[0];

    if(!t){await client.query('ROLLBACK');return res.status(404).json({error:'Ticket no encontrado'});}
    if(!canAct(req.session.user,t.department)){await client.query('ROLLBACK');return res.status(403).json({error:'No autorizado para esta Ã¡rea'});}
    if(['closed','cancelled'].includes(t.status)){await client.query('ROLLBACK');return res.status(409).json({error:'El ticket ya estÃ¡ cerrado'});}

    const transitions={
      assigned:['in_progress','waiting','escalated','resolved'],
      in_progress:['waiting','escalated','resolved'],
      waiting:['in_progress','escalated','resolved'],
      escalated:['in_progress','waiting','resolved'],
      resolved:['closed']
    };
    if(!(transitions[t.status]||[]).includes(desired)){
      await client.query('ROLLBACK');
      return res.status(409).json({error:`TransiciÃ³n no permitida: ${ticketStateLabel(t.status)} â†’ ${ticketStateLabel(desired)}`});
    }
    if(desired==='closed'&&!isManager(req.session.user)){
      await client.query('ROLLBACK');return res.status(403).json({error:'SÃ³lo Admin/Superadmin puede cerrar manualmente'});
    }

    const textReason=String(req.body.reason||'').trim();
    const solution=String(req.body.comment||'').trim();
    const closureComment=String(req.body.closureComment||'').trim();

    if(desired==='waiting'&&!textReason){await client.query('ROLLBACK');return res.status(400).json({error:'Indica el motivo de espera'});}
    if(desired==='escalated'&&!textReason){await client.query('ROLLBACK');return res.status(400).json({error:'Indica el motivo del escalamiento'});}
    if(desired==='resolved'&&!solution){await client.query('ROLLBACK');return res.status(400).json({error:'Captura la soluciÃ³n aplicada'});}
    if(desired==='closed'&&!closureComment){await client.query('ROLLBACK');return res.status(400).json({error:'Captura la soluciÃ³n/comentario final de cierre'});}

    let totalWait=Number(t.total_wait_seconds||0);
    let resolutionDue=t.resolution_due_at ? new Date(t.resolution_due_at) : null;
    let waitStarted=t.wait_started_at ? new Date(t.wait_started_at) : null;

    if(t.status==='waiting' && desired!=='waiting' && waitStarted){
      const elapsed=Math.max(0,Math.floor((Date.now()-waitStarted.getTime())/1000));
      totalWait+=elapsed;
      if(t.pause_on_waiting && resolutionDue) resolutionDue=new Date(resolutionDue.getTime()+elapsed*1000);
      waitStarted=null;
    }

    if(desired==='waiting' && t.status!=='waiting') waitStarted=new Date();

    if(desired==='in_progress'){
      await client.query(`
        UPDATE tickets SET status='in_progress',wait_started_at=$1,total_wait_seconds=$2,resolution_due_at=$3,updated_at=NOW()
        WHERE id=$4`,[waitStarted,totalWait,resolutionDue,t.id]);
    }else if(desired==='waiting'){
      await client.query(`
        UPDATE tickets SET status='waiting',wait_started_at=$1,total_wait_seconds=$2,wait_reason=$3,updated_at=NOW()
        WHERE id=$4`,[waitStarted,totalWait,textReason,t.id]);
    }else if(desired==='escalated'){
      await client.query(`
        UPDATE tickets SET status='escalated',wait_started_at=$1,total_wait_seconds=$2,resolution_due_at=$3,
          escalation_reason=$4,updated_at=NOW()
        WHERE id=$5`,[waitStarted,totalWait,resolutionDue,textReason,t.id]);
    }else if(desired==='resolved'){
      const autoCloseAt=new Date(Date.now()+Number(t.autoclose_minutes||10)*60000);
      await client.query(`
        UPDATE tickets SET status='resolved',wait_started_at=NULL,total_wait_seconds=$1,resolution_due_at=$2,
          resolution_notes=$3,resolved_at=NOW(),resolved_by=$4,auto_close_at=$5,updated_at=NOW()
        WHERE id=$6`,[totalWait,resolutionDue,solution,req.session.user.id,autoCloseAt,t.id]);
    }else if(desired==='closed'){
      await client.query(`
        UPDATE tickets SET status='closed',closure_notes=$1,closed_at=NOW(),closure_type='manual',
          auto_close_at=NULL,updated_at=NOW()
        WHERE id=$2`,[closureComment,t.id]);
    }

    await client.query(`
      UPDATE support_requests SET
        status=$1::varchar,
        resolved_at=CASE WHEN $1::varchar='resolved'::varchar THEN COALESCE(resolved_at,NOW()) ELSE resolved_at END,
        resolved_by=CASE WHEN $1::varchar='resolved'::varchar THEN $2 ELSE resolved_by END,
        closed_at=CASE WHEN $1::varchar='closed'::varchar THEN NOW() ELSE closed_at END,
        updated_at=NOW()
      WHERE id=$3`,[desired,req.session.user.id,t.request_id]);

    const saved=(await client.query(`SELECT * FROM tickets WHERE id=$1`,[t.id])).rows[0];
    const eventComment=textReason||solution||closureComment||null;
    await logTicketEvent(client,t.id,'status_changed',t.status,desired,req.session.user.id,eventComment);
    await client.query('COMMIT');

    io.emit('ticket:changed',{action:'status',ticketId:t.id,status:desired,stationCode:t.station_current_code,department:t.department});
    io.emit('request:changed',{action:desired==='resolved'?'resolved':desired==='closed'?'closed':'updated',id:t.request_id,stationCode:t.station_current_code,department:t.department});
    res.json(saved);
  }catch(e){
    try{await client.query('ROLLBACK')}catch{}
    console.error('R10.5 ticket status:',e);
    res.status(500).json({error:`No se pudo cambiar el estado${e.code?' ('+e.code+')':''}`});
  }finally{client.release();}
});

app.get('/api/history',requireAuth,async(req,res)=>{
  const user=req.session.user;
  if(user.role==='engineer')return res.status(403).json({error:'Historial disponible para Admin/Superadmin'});
  const {rows}=await pool.query(`
    SELECT t.*,r.requested_at,r.requested_by,r.attended_at,
           u.full_name assigned_to_name,ur.full_name resolved_by_name,
           sp.name sla_name,sp.response_minutes,sp.resolution_minutes,sp.pause_on_waiting,
           COALESCE(t.assigned_at,r.attended_at) actual_response_at,
           CASE WHEN COALESCE(t.assigned_at,r.attended_at) IS NOT NULL
                THEN GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(t.assigned_at,r.attended_at)-r.requested_at))::bigint) END response_seconds,
           CASE WHEN t.resolved_at IS NOT NULL
                THEN GREATEST(0,EXTRACT(EPOCH FROM (t.resolved_at-r.requested_at))::bigint) END resolution_seconds,
           CASE WHEN COALESCE(t.assigned_at,r.attended_at) IS NULL OR t.response_due_at IS NULL THEN NULL
                ELSE COALESCE(t.assigned_at,r.attended_at) <= t.response_due_at END response_sla_met,
           CASE WHEN t.resolved_at IS NULL OR t.resolution_due_at IS NULL THEN NULL
                ELSE t.resolved_at <= t.resolution_due_at END resolution_sla_met
    FROM tickets t
    JOIN support_requests r ON r.id=t.request_id
    LEFT JOIN users u ON u.id=t.assigned_to
    LEFT JOIN users ur ON ur.id=t.resolved_by
    LEFT JOIN sla_policies sp ON sp.id=t.sla_policy_id
    WHERE t.status = ANY($1::text[])
    ORDER BY COALESCE(t.closed_at,t.updated_at) DESC
    LIMIT 1000`,[HISTORY_STATUSES]);
  res.json(rows);
});

// ============================================================
// REPORTES DINÃMICOS
// ============================================================
app.get('/api/report-filters',requireAuth,async(req,res)=>{
  const dept=userDepartment(req.session.user);
  const engineers=await pool.query(`
    SELECT id,full_name,role,department
    FROM users
    WHERE active=TRUE
      AND deleted_at IS NULL
      ${dept?`AND (role IN ('superadmin','admin') OR (role='engineer' AND department=$1))`:''}
    ORDER BY
      CASE role WHEN 'superadmin' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,
      full_name
  `,dept?[dept]:[]);
  const groups=await pool.query(`SELECT id,name FROM production_groups WHERE archived_at IS NULL ORDER BY name`);
  const categories=await pool.query(`SELECT department,code,label FROM support_categories WHERE enabled=TRUE ${dept?'AND department=$1':''} ORDER BY department,sort_order,label`,dept?[dept]:[]);
  res.json({engineers:engineers.rows,groups:groups.rows,categories:categories.rows,statuses:['unassigned','assigned','in_progress','waiting','escalated','resolved','closed']});
});

app.get('/api/reports',requireAuth,async(req,res)=>{
  try{
    const user=req.session.user;
    const params=[];
    const cond=[];

    const forcedDept=userDepartment(user);
    const selectedDept=String(req.query.department||'').trim();
    const dept=forcedDept || selectedDept;
    if(dept && ['systems','maintenance'].includes(dept)){
      params.push(dept);
      cond.push(`r.department=$${params.length}`);
    }

    const from=String(req.query.from||'').trim();
    const to=String(req.query.to||'').trim();

    if(from){
      params.push(from);
      cond.push(`r.requested_at >= $${params.length}::date`);
    }else{
      cond.push(`r.requested_at >= CURRENT_DATE - INTERVAL '29 days'`);
    }

    if(to){
      params.push(to);
      cond.push(`r.requested_at < ($${params.length}::date + INTERVAL '1 day')`);
    }

    const groupId=Number(req.query.groupId||0);
    if(groupId){
      params.push(groupId);
      cond.push(`s.group_id=$${params.length}`);
    }

    const category=String(req.query.category||'').trim();
    if(category){
      params.push(category);
      cond.push(`r.category=$${params.length}`);
    }

    const engineerId=Number(req.query.engineerId||0);
    if(engineerId){
      params.push(engineerId);
      cond.push(`t.assigned_to=$${params.length}`);
    }

    const status=String(req.query.status||'').trim();
    if(status){
      params.push(status);
      cond.push(`COALESCE(t.status,r.status)=$${params.length}`);
    }

    const where=cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const {rows}=await pool.query(`
      SELECT
        r.id request_id,
        r.department,
        r.category,
        r.requested_at,
        r.status request_status,
        s.id station_id,
        s.code station_code,
        s.label station_name,
        s.group_id,
        COALESCE(g.name,'Sin grupo') group_name,
        COALESCE(c.label,r.category,'Sin categorÃ­a') category_label,
        t.id ticket_id,
        t.ticket_number,
        t.status ticket_status,
        t.assigned_to,
        t.assigned_at,
        t.resolved_at,
        t.closed_at,
        t.response_due_at,
        t.resolution_due_at,
        COALESCE(t.total_wait_seconds,0)::bigint total_wait_seconds,
        COALESCE(u.full_name,'Sin asignar') engineer_name,
        sp.name sla_name,
        sp.response_minutes,
        sp.resolution_minutes
      FROM support_requests r
      LEFT JOIN stations s ON s.id=r.station_id
      LEFT JOIN production_groups g ON g.id=s.group_id
      LEFT JOIN support_categories c ON c.department=r.department AND c.code=r.category LEFT JOIN admin_support_requests_catalog ac ON ac.department=r.department AND ac.code=r.category
      LEFT JOIN tickets t ON t.request_id=r.id
      LEFT JOIN users u ON u.id=t.assigned_to
      LEFT JOIN sla_policies sp ON sp.id=COALESCE(t.sla_policy_id,r.sla_policy_id)
      ${where}
      ORDER BY r.requested_at ASC
    `,params);

    const num=v=>v===null||v===undefined?null:Number(v);
    const epoch=v=>v?new Date(v).getTime():null;
    const dayKey=v=>{
      if(!v)return null;
      const d=new Date(v);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    };
    const statusOf=x=>x.ticket_status||x.request_status||'unassigned';
    const responseSeconds=x=>{
      const a=epoch(x.assigned_at),r=epoch(x.requested_at);
      return a&&r?Math.max(0,Math.round((a-r)/1000)):null;
    };
    const resolutionSeconds=x=>{
      const z=epoch(x.resolved_at),r=epoch(x.requested_at);
      if(!z||!r)return null;
      return Math.max(0,Math.round((z-r)/1000)-Number(x.total_wait_seconds||0));
    };
    const responseMet=x=>{
      const a=epoch(x.assigned_at),due=epoch(x.response_due_at);
      return a&&due ? a<=due : null;
    };
    const resolutionMet=x=>{
      const z=epoch(x.resolved_at),due=epoch(x.resolution_due_at);
      return z&&due ? z<=due : null;
    };
    const avg=arr=>{
      const vals=arr.filter(v=>v!==null&&Number.isFinite(Number(v))).map(Number);
      return vals.length?Math.round(vals.reduce((a,b)=>a+b,0)/vals.length):null;
    };
    const countBy=(arr,keyFn)=>{
      const m=new Map();
      for(const x of arr){
        const k=keyFn(x)||'Sin dato';
        m.set(k,(m.get(k)||0)+1);
      }
      return [...m.entries()].map(([label,total])=>({label,total})).sort((a,b)=>b.total-a.total);
    };

    const measuredResponse=rows.filter(x=>responseMet(x)!==null);
    const measuredResolution=rows.filter(x=>resolutionMet(x)!==null);
    const responseMetCount=measuredResponse.filter(x=>responseMet(x)).length;
    const resolutionMetCount=measuredResolution.filter(x=>resolutionMet(x)).length;

    const summary={
      total:rows.length,
      closed:rows.filter(x=>statusOf(x)==='closed').length,
      response_met:responseMetCount,
      response_measured:measuredResponse.length,
      resolution_met:resolutionMetCount,
      resolution_measured:measuredResolution.length,
      avg_response_seconds:avg(rows.map(responseSeconds)),
      avg_resolution_seconds:avg(rows.map(resolutionSeconds))
    };

    const byEngineer=countBy(rows,x=>x.engineer_name);
    const byCategory=countBy(rows,x=>x.category_label);
    const byGroup=countBy(rows,x=>x.group_name);
    const byStatus=countBy(rows,statusOf);
    const byArea=countBy(rows,x=>x.department);

    const dailyMap=new Map();
    for(const x of rows){
      const k=dayKey(x.requested_at);
      if(!k)continue;
      if(!dailyMap.has(k))dailyMap.set(k,{day:k,created:0,resolved:0});
      const d=dailyMap.get(k);
      d.created++;
      if(x.resolved_at)d.resolved++;
    }
    const daily=[...dailyMap.values()].sort((a,b)=>a.day.localeCompare(b.day));

    const categoryMap=new Map();
    for(const x of rows){
      const met=resolutionMet(x);
      if(met===null)continue;
      const k=x.category_label||'Sin categorÃ­a';
      if(!categoryMap.has(k))categoryMap.set(k,{label:k,measured:0,met:0});
      const o=categoryMap.get(k);
      o.measured++;
      if(met)o.met++;
    }
    const categorySla=[...categoryMap.values()]
      .map(x=>({...x,percentage:x.measured?Math.round(x.met/x.measured*100):0}))
      .sort((a,b)=>b.measured-a.measured||a.label.localeCompare(b.label))
      .slice(0,10);

    const engMap=new Map();
    for(const x of rows){
      const k=x.engineer_name||'Sin asignar';
      if(!engMap.has(k))engMap.set(k,{label:k,total:0,response:[],resolution:[],sla_measured:0,sla_met:0});
      const o=engMap.get(k);
      o.total++;
      const rs=responseSeconds(x),zs=resolutionSeconds(x),met=resolutionMet(x);
      if(rs!==null)o.response.push(rs);
      if(zs!==null)o.resolution.push(zs);
      if(met!==null){o.sla_measured++;if(met)o.sla_met++;}
    }
    const engineerPerformance=[...engMap.values()].map(o=>{
      const assignedRows=rows.filter(x=>(x.engineer_name||'Sin asignar')===o.label);
      const closed=assignedRows.filter(x=>statusOf(x)==='closed').length;
      const pending=Math.max(0,o.total-closed);
      return {
        label:o.label,total:o.total,closed,pending,
        closure_percentage:o.total?Math.round(closed/o.total*100):0,
        avg_response_seconds:avg(o.response),
        avg_resolution_seconds:avg(o.resolution),
        sla_measured:o.sla_measured,
        sla_met:o.sla_met,
        sla_percentage:o.sla_measured?Math.round(o.sla_met/o.sla_measured*100):null
      };
    }).sort((a,b)=>b.total-a.total).slice(0,10);

    const stationMap=new Map();
    for(const x of rows){
      const k=String(x.station_id);
      if(!stationMap.has(k))stationMap.set(k,{
        label:x.station_code,
        station_name:x.station_name||'',
        group_name:x.group_name||'Sin grupo',
        total:0,resolutions:[],cats:new Map()
      });
      const o=stationMap.get(k);
      o.total++;
      const z=resolutionSeconds(x); if(z!==null)o.resolutions.push(z);
      const c=x.category_label||'Sin categorÃ­a';
      o.cats.set(c,(o.cats.get(c)||0)+1);
    }
    const recurrent=[...stationMap.values()].map(o=>{
      const principal=[...o.cats.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||'â€”';
      return {label:o.label,station_name:o.station_name,group_name:o.group_name,total:o.total,
        principal_incident:principal,avg_resolution_seconds:avg(o.resolutions)};
    }).sort((a,b)=>b.total-a.total).slice(0,5);

    const bucketOrder=['< 15 min','15 - 30 min','30 - 60 min','1 - 2 h','> 2 h'];
    const bucketMap=Object.fromEntries(bucketOrder.map(k=>[k,0]));
    for(const x of rows){
      const s=resolutionSeconds(x);
      if(s===null)continue;
      const k=s<900?'< 15 min':s<1800?'15 - 30 min':s<3600?'30 - 60 min':s<7200?'1 - 2 h':'> 2 h';
      bucketMap[k]++;
    }
    const totalResolved=Object.values(bucketMap).reduce((a,b)=>a+b,0);
    const resolutionDistribution=bucketOrder.map(label=>({
      label,total:bucketMap[label],percentage:totalResolved?Math.round(bucketMap[label]/totalResolved*100):0
    }));

    res.json({
      summary,byEngineer,byCategory,byGroup,byStatus,byArea,daily,categorySla,
      engineerPerformance,recurrent,resolutionDistribution,
      debug:{rows:rows.length,from:from||null,to:to||null,department:dept||null}
    });
  }catch(e){
    console.error('R10.8.1 reports:',e);
    res.status(500).json({error:`Reportes: ${e.message}${e.code?' ('+e.code+')':''}`});
  }
});

// ============================================================
// ADMIN: GRUPOS / EQUIPOS CON CÃ“DIGO AUTOMÃTICO
// ============================================================
app.get('/api/admin/groups',requireManager,async(req,res)=>{
  const groups=await pool.query(`SELECT * FROM production_groups WHERE archived_at IS NULL ORDER BY sort_order,name`);
  const stations=await pool.query(`SELECT s.*,g.name group_name,g.code group_code FROM stations s LEFT JOIN production_groups g ON g.id=s.group_id WHERE s.archived_at IS NULL ORDER BY g.sort_order,s.station_no,s.code`);
  res.json({groups:groups.rows,stations:stations.rows});
});

app.post('/api/admin/groups',requireManager,async(req,res)=>{
  const name=String(req.body.name||'').trim(); if(!name)return res.status(400).json({error:'Nombre requerido'});
  const code=slug(name); if(!code)return res.status(400).json({error:'No se pudo generar cÃ³digo'});
  try{
    const n=(await pool.query(`SELECT COALESCE(MAX(legacy_line_no),0)+1 n FROM production_groups`)).rows[0].n;
    const q=(await pool.query(`INSERT INTO production_groups(code,name,sort_order,legacy_line_no) VALUES($1,$2,$3,$4) RETURNING *`,[code,name,n*10,n])).rows[0];
    io.emit('data:changed',{type:'groups'});res.status(201).json(q);
  }catch(e){if(e.code==='23505')return res.status(409).json({error:'Ya existe un grupo con ese nombre/cÃ³digo'});throw e;}
});

app.patch('/api/admin/groups/:id',requireManager,async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const g=(await client.query(`SELECT * FROM production_groups WHERE id=$1 FOR UPDATE`,[req.params.id])).rows[0];
    if(!g){await client.query('ROLLBACK');return res.status(404).json({error:'Grupo no encontrado'});}
    const newName=String(req.body.name||g.name).trim(); const newCode=slug(newName); const enabled=req.body.enabled;
    if(!newName||!newCode){await client.query('ROLLBACK');return res.status(400).json({error:'Nombre de grupo invÃ¡lido'});}
    if(newName!==g.name || newCode!==g.code){
      const sts=(await client.query(`SELECT * FROM stations WHERE group_id=$1 AND archived_at IS NULL FOR UPDATE`,[g.id])).rows;
      for(const st of sts){
        const equipmentName=cleanStationLabel(st.label,g.name);
        const newStationCode=stationCodeFromNames(newName,equipmentName);
        if(newStationCode && newStationCode!==st.code){
          await client.query(`INSERT INTO station_aliases(station_id,old_code) VALUES($1,$2) ON CONFLICT(old_code) DO NOTHING`,[st.id,st.code]);
          await client.query(`UPDATE stations SET code=$1,label=$2,updated_at=NOW() WHERE id=$3`,[newStationCode,equipmentName,st.id]);
        }
      }
    }
    const q=(await client.query(`UPDATE production_groups SET name=$1,code=$2,enabled=COALESCE($3,enabled),updated_at=NOW() WHERE id=$4 RETURNING *`,[newName,newCode,enabled,g.id])).rows[0];
    await client.query('COMMIT');io.emit('data:changed',{type:'groups'});res.json(q);
  }catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:'El nuevo nombre genera un cÃ³digo duplicado'});console.error(e);res.status(500).json({error:'No se pudo renombrar grupo/equipos'});}finally{client.release();}
});

app.delete('/api/admin/groups/:id',requireManager,async(req,res)=>{
  await pool.query(`UPDATE production_groups SET enabled=FALSE,archived_at=NOW(),updated_at=NOW() WHERE id=$1`,[req.params.id]);
  await pool.query(`UPDATE stations SET enabled=FALSE,archived_at=COALESCE(archived_at,NOW()),updated_at=NOW() WHERE group_id=$1`,[req.params.id]);
  io.emit('data:changed',{type:'groups'});res.json({ok:true});
});

app.post('/api/admin/stations',requireManager,async(req,res)=>{
  const groupId=Number(req.body.groupId); const name=String(req.body.name||'').trim(); if(!groupId||!name)return res.status(400).json({error:'Grupo y nombre son requeridos'});
  const g=(await pool.query(`SELECT * FROM production_groups WHERE id=$1 AND archived_at IS NULL`,[groupId])).rows[0]; if(!g)return res.status(404).json({error:'Grupo no encontrado'});
  const code=stationCodeFromNames(g.name,name); if(!code)return res.status(400).json({error:'Nombre de equipo invÃ¡lido'});
  const next=(await pool.query(`SELECT COALESCE(MAX(station_no),0)+1 n FROM stations WHERE group_id=$1`,[groupId])).rows[0].n;
  try{const q=(await pool.query(`INSERT INTO stations(code,line_no,station_no,label,group_id,enabled) VALUES($1,$2,$3,$4,$5,TRUE) RETURNING *`,[code,g.legacy_line_no,next,name,groupId])).rows[0];io.emit('data:changed',{type:'stations'});res.status(201).json(q);}catch(e){if(e.code==='23505')return res.status(409).json({error:`Ya existe ${code}. Usa otro nombre.`});throw e;}
});

app.patch('/api/admin/stations/:id',requireManager,async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const s=(await client.query(`SELECT s.*,g.code group_code,g.legacy_line_no FROM stations s LEFT JOIN production_groups g ON g.id=s.group_id WHERE s.id=$1 FOR UPDATE`,[req.params.id])).rows[0]; if(!s){await client.query('ROLLBACK');return res.status(404).json({error:'Equipo no encontrado'});}
    const groupId=Number(req.body.groupId||s.group_id); const g=(await client.query(`SELECT * FROM production_groups WHERE id=$1 AND archived_at IS NULL`,[groupId])).rows[0]; if(!g){await client.query('ROLLBACK');return res.status(404).json({error:'Grupo no encontrado'});}
    const name=String(req.body.name||s.label).trim(); if(!name){await client.query('ROLLBACK');return res.status(400).json({error:'Nombre de equipo requerido'});}
    const newCode=stationCodeFromNames(g.name,name); const enabled=req.body.enabled;
    if(!newCode){await client.query('ROLLBACK');return res.status(400).json({error:'Nombre de equipo invÃ¡lido'});}
    if(newCode!==s.code) await client.query(`INSERT INTO station_aliases(station_id,old_code) VALUES($1,$2) ON CONFLICT(old_code) DO NOTHING`,[s.id,s.code]);
    const q=(await client.query(`UPDATE stations SET label=$1,code=$2,group_id=$3,line_no=$4,enabled=COALESCE($5,enabled),updated_at=NOW() WHERE id=$6 RETURNING *`,[name,newCode,groupId,g.legacy_line_no,enabled,s.id])).rows[0];
    await client.query('COMMIT');io.emit('data:changed',{type:'stations',stationCode:q.code});res.json(q);
  }catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:'Ya existe un equipo con ese nombre dentro del grupo'});console.error('R10.4 rename station:',e);res.status(500).json({error:`No se pudo renombrar el equipo${e.code?' ('+e.code+')':''}`});}finally{client.release();}
});
app.delete('/api/admin/stations/:id',requireManager,async(req,res)=>{await pool.query(`UPDATE stations SET enabled=FALSE,archived_at=NOW(),updated_at=NOW() WHERE id=$1`,[req.params.id]);io.emit('data:changed',{type:'stations'});res.json({ok:true});});

// ============================================================
// ADMIN: USUARIOS Y PRIVILEGIOS
// ============================================================
app.get('/api/admin/users',requireManager,async(req,res)=>{
  const {rows}=await pool.query(`SELECT id,username,full_name,role,department,active,created_at,updated_at FROM users WHERE deleted_at IS NULL ORDER BY CASE role WHEN 'superadmin' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,full_name`);res.json(rows);
});
app.post('/api/admin/users',requireManager,async(req,res)=>{
  const username=String(req.body.username||'').trim();const fullName=String(req.body.fullName||'').trim();const role=String(req.body.role||'engineer');const department=role==='engineer'?String(req.body.department||''):null;const password=String(req.body.password||'');
  if(!username||!fullName||password.length<6)return res.status(400).json({error:'Usuario, nombre y contraseÃ±a (mÃ­n. 6) requeridos'});
  if(!['admin','engineer','superadmin'].includes(role))return res.status(400).json({error:'Rol invÃ¡lido'});
  if(role==='superadmin' && req.session.user.role!=='superadmin')return res.status(403).json({error:'SÃ³lo Superadmin puede crear otro Superadmin'});
  if(role==='engineer'&&!['systems','maintenance'].includes(department))return res.status(400).json({error:'Selecciona Ã¡rea del ingeniero'});
  try{const hash=await bcrypt.hash(password,10);const q=(await pool.query(`INSERT INTO users(username,password_hash,full_name,role,department,active) VALUES($1,$2,$3,$4,$5,TRUE) RETURNING id,username,full_name,role,department,active`,[username,hash,fullName,role,department])).rows[0];res.status(201).json(q);}catch(e){if(e.code==='23505')return res.status(409).json({error:'Usuario duplicado'});throw e;}
});
app.patch('/api/admin/users/:id',requireManager,async(req,res)=>{
  const target=(await pool.query(`SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL`,[req.params.id])).rows[0];if(!target)return res.status(404).json({error:'Usuario no encontrado'});
  if(target.role==='superadmin' && req.session.user.role!=='superadmin')return res.status(403).json({error:'Admin no puede modificar al Superadmin'});
  const role=String(req.body.role||target.role);if(role==='superadmin'&&req.session.user.role!=='superadmin')return res.status(403).json({error:'No autorizado'});
  const department=role==='engineer'?String(req.body.department||target.department||''):null;
  const q=(await pool.query(`UPDATE users SET full_name=COALESCE(NULLIF($1,''),full_name),role=$2,department=$3,active=COALESCE($4,active),updated_at=NOW() WHERE id=$5 RETURNING id,username,full_name,role,department,active`,[String(req.body.fullName||''),role,department,req.body.active,req.params.id])).rows[0];res.json(q);
});
app.post('/api/admin/users/:id/reset-password',requireManager,async(req,res)=>{
  const target=(await pool.query(`SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL`,[req.params.id])).rows[0];if(!target)return res.status(404).json({error:'Usuario no encontrado'});
  if(target.role==='superadmin'&&req.session.user.role!=='superadmin')return res.status(403).json({error:'Admin no puede restablecer al Superadmin'});
  const password=String(req.body.password||'');if(password.length<6)return res.status(400).json({error:'ContraseÃ±a mÃ­nimo 6 caracteres'});const hash=await bcrypt.hash(password,10);await pool.query(`UPDATE users SET password_hash=$1,updated_at=NOW() WHERE id=$2`,[hash,target.id]);res.json({ok:true});
});
app.delete('/api/admin/users/:id',requireManager,async(req,res)=>{
  const target=(await pool.query(`SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL`,[req.params.id])).rows[0];if(!target)return res.status(404).json({error:'Usuario no encontrado'});
  if(target.role==='superadmin')return res.status(403).json({error:'El usuario Superadmin no se puede eliminar'});
  if(Number(target.id)===Number(req.session.user.id))return res.status(409).json({error:'No puedes eliminar tu propia sesiÃ³n'});
  await pool.query(`UPDATE users SET active=FALSE,deleted_at=NOW(),updated_at=NOW() WHERE id=$1`,[target.id]);res.json({ok:true});
});

// ============================================================
// ADMIN: SLA
// ============================================================
app.get('/api/admin/slas',requireManager,async(req,res)=>{const {rows}=await pool.query(`SELECT s.*,COALESCE(ac.label,c.label,r.category) category_label,g.name group_name,st.code station_code,st.label station_name FROM sla_policies s LEFT JOIN support_categories c ON c.department=s.department AND c.code=s.category LEFT JOIN production_groups g ON g.id=s.group_id LEFT JOIN stations st ON st.id=s.station_id ORDER BY s.enabled DESC,s.priority,s.name`);res.json(rows);});
app.post('/api/admin/slas',requireManager,async(req,res)=>{
  const body=req.body;const name=String(body.name||'').trim();if(!name)return res.status(400).json({error:'Nombre requerido'});
  const department=['systems','maintenance'].includes(body.department)?body.department:null;const category=String(body.category||'').trim()||null;const groupId=Number(body.groupId||0)||null;const stationId=Number(body.stationId||0)||null;
  const q=(await pool.query(`INSERT INTO sla_policies(name,department,category,group_id,station_id,response_minutes,resolution_minutes,autoclose_minutes,pause_on_waiting,priority,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE) RETURNING *`,[name,department,category,groupId,stationId,Number(body.responseMinutes||5),Number(body.resolutionMinutes||60),Number(body.autocloseMinutes||10),body.pauseOnWaiting!==false,Number(body.priority||100)])).rows[0];io.emit('data:changed',{type:'sla'});res.status(201).json(q);
});
app.patch('/api/admin/slas/:id',requireManager,async(req,res)=>{
  const b=req.body;const q=(await pool.query(`UPDATE sla_policies SET name=COALESCE(NULLIF($1,''),name),department=$2,category=$3,group_id=$4,station_id=$5,response_minutes=COALESCE($6,response_minutes),resolution_minutes=COALESCE($7,resolution_minutes),autoclose_minutes=COALESCE($8,autoclose_minutes),pause_on_waiting=COALESCE($9,pause_on_waiting),priority=COALESCE($10,priority),enabled=COALESCE($11,enabled),updated_at=NOW() WHERE id=$12 RETURNING *`,[String(b.name||''),['systems','maintenance'].includes(b.department)?b.department:null,String(b.category||'').trim()||null,Number(b.groupId||0)||null,Number(b.stationId||0)||null,b.responseMinutes?Number(b.responseMinutes):null,b.resolutionMinutes?Number(b.resolutionMinutes):null,b.autocloseMinutes?Number(b.autocloseMinutes):null,b.pauseOnWaiting,b.priority?Number(b.priority):null,b.enabled,req.params.id])).rows[0];if(!q)return res.status(404).json({error:'SLA no encontrado'});io.emit('data:changed',{type:'sla'});res.json(q);
});
app.delete('/api/admin/slas/:id',requireManager,async(req,res)=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const found=(await client.query(`SELECT id,name FROM sla_policies WHERE id=$1 FOR UPDATE`,[req.params.id])).rows[0];
    if(!found){await client.query('ROLLBACK');return res.status(404).json({error:'Regla SLA no encontrada'});}
    // Conservar histÃ³ricos: tickets/solicitudes mantienen sus timestamps SLA, sÃ³lo se desprenden de la regla eliminada.
    await client.query(`UPDATE tickets SET sla_policy_id=NULL WHERE sla_policy_id=$1`,[req.params.id]);
    await client.query(`UPDATE support_requests SET sla_policy_id=NULL WHERE sla_policy_id=$1`,[req.params.id]);
    await client.query(`DELETE FROM sla_policies WHERE id=$1`,[req.params.id]);
    await client.query('COMMIT');
    io.emit('data:changed',{type:'sla',action:'deleted',id:Number(req.params.id)});res.json({ok:true,deleted:true,name:found.name});
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
});

// ============================================================
// AUTOCIERRE: RESUELTO -> CERRADO despuÃ©s del SLA configurado
// ============================================================
async function autoCloseResolved(){
  const client=await pool.connect();
  try{
    const due=(await client.query(`SELECT t.id,t.request_id,t.department,s.code station_code FROM tickets t JOIN support_requests r ON r.id=t.request_id LEFT JOIN stations s ON s.id=r.station_id WHERE t.status='resolved' AND t.auto_close_at IS NOT NULL AND t.auto_close_at<=NOW() ORDER BY t.auto_close_at LIMIT 100`)).rows;
    for(const t of due){
      await client.query('BEGIN');
      const q=await client.query(`UPDATE tickets SET status='closed',closed_at=NOW(),closure_type='auto',
        closure_notes=COALESCE(NULLIF(closure_notes,''),resolution_notes,'Cierre automÃ¡tico despuÃ©s de la ventana de validaciÃ³n'),
        updated_at=NOW() WHERE id=$1 AND status='resolved' RETURNING id`,[t.id]);
      if(q.rowCount){
        await client.query(`UPDATE support_requests SET status='closed',closed_at=NOW(),updated_at=NOW() WHERE id=$1`,[t.request_id]);
        await logTicketEvent(client,t.id,'auto_closed','resolved','closed',null,'Cierre automÃ¡tico por ventana de validaciÃ³n SLA');
      }
      await client.query('COMMIT');
      if(q.rowCount){io.emit('ticket:changed',{action:'closed',ticketId:t.id,status:'closed',stationCode:t.station_code,department:t.department});io.emit('request:changed',{action:'closed',id:t.request_id,stationCode:t.station_code,department:t.department});}
    }
  }catch(e){try{await client.query('ROLLBACK');}catch{}console.error('autoCloseResolved',e);}finally{client.release();}
}
setInterval(autoCloseResolved,15000);
setTimeout(autoCloseResolved,5000);

io.on('connection',socket=>{
  socket.emit('connected',{ok:true});
  socket.emit('server:hello',{build:APP_BUILD,bootId:BOOT_ID,serverTime:new Date().toISOString()});
});

server.listen(PORT,HOST,()=>{
  console.log(`Andon Support R10 ejecutÃ¡ndose en http://localhost:${PORT}`);
  console.log(`Cliente: http://localhost:${PORT}/station/L1-E1`);
  console.log(`Dashboard: http://localhost:${PORT}/login`);
});

