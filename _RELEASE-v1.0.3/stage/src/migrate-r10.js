require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./db');
(async()=>{
  try {
    const sql=fs.readFileSync(path.join(__dirname,'..','sql','migrate-r10.sql'),'utf8');
    await pool.query(sql);
    console.log('Migración R10 completada.');
  } catch(e) {
    console.error('Migración R10 falló:',e);
    process.exitCode=1;
  } finally { await pool.end(); }
})();
