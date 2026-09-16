require('dotenv').config();
const fs=require('fs');
const path=require('path');
const pool=require('./db');
(async()=>{const c=await pool.connect();try{const sql=fs.readFileSync(path.join(__dirname,'..','sql','migrate-soporte-r1.sql'),'utf8').replace(/^\uFEFF/,'');await c.query(sql);console.log('Migracion SOPORTE R1 completada.');}catch(e){console.error(e);process.exitCode=1;}finally{c.release();await pool.end();}})();
