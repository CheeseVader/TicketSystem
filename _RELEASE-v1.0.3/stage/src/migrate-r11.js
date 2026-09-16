require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./db');
(async()=>{
  try {
    const sql=fs.readFileSync(path.join(__dirname,'..','sql','migrate-r11.sql'),'utf8');
    await pool.query(sql);
    console.log('Migracion R11 completada.');
  } catch(e) {
    console.error('Migracion R11 fallo:',e);
    process.exitCode=1;
  } finally { await pool.end(); }
})();
