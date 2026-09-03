require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./db');

(async () => {
  try {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
    await pool.query(schema);

    for (let line = 1; line <= 3; line++) {
      for (let station = 1; station <= 8; station++) {
        const code = `L${line}-E${station}`;
        await pool.query(
          `INSERT INTO stations(code,line_no,station_no,label) VALUES($1,$2,$3,$4)
           ON CONFLICT(code) DO NOTHING`,
          [code, line, station, `Línea ${line} - Estación ${station}`]
        );
      }
    }

    const password = 'Demo123!';
    const hash = await bcrypt.hash(password, 10);
    const users = [
      ['sistemas1', 'Técnico Sistemas 1', 'systems'],
      ['mantenimiento1', 'Técnico Mantenimiento 1', 'maintenance'],
      ['superadmin', 'Super Administrador', 'superadmin']
    ];
    for (const [username, fullName, role] of users) {
      await pool.query(
        `INSERT INTO users(username,password_hash,full_name,role)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(username) DO UPDATE SET full_name=EXCLUDED.full_name, role=EXCLUDED.role`,
        [username, hash, fullName, role]
      );
    }

    console.log('Base de datos inicializada.');
    console.log('Usuarios demo: sistemas1 / mantenimiento1 / superadmin');
    console.log('Password demo: Demo123!');
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
