require('dotenv').config();
const fs=require('fs');const path=require('path');const pool=require('./db');
(async()=>{const client=await pool.connect();try{const sql=fs.readFileSync(path.join(__dirname,'..','sql','migrate-r11-4.sql'),'utf8').replace(/^\uFEFF/,'');console.log('[DB] Aplicando migrate-r11-4.sql...');await client.query(sql);console.log('[DB] R11.4 completada.');}catch(e){console.error('[DB] R11.4 falló:',e);process.exitCode=1;}finally{client.release();await pool.end();}})();
