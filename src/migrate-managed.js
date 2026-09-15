require('dotenv').config();
const fs=require('fs');
const path=require('path');
const pool=require('./db');
(async()=>{
  const client=await pool.connect();
  try{
    for(const file of ['migrate-r11.sql','migrate-r11-2.sql','migrate-r11-4.sql','migrate-r1.8.7-p2-single-session.sql','migrate-r1.8.7-p3-plants-users-areas.sql']){
      const full=path.join(__dirname,'..','sql',file);
      if(!fs.existsSync(full)) continue;
      const sql=fs.readFileSync(full,'utf8').replace(/^\uFEFF/,'');
      console.log(`[DB] Aplicando ${file}...`);
      await client.query(sql);
    }
    console.log('[DB] Migraciones administradas completadas.');
  }catch(e){
    console.error('[DB] MigraciÃ³n administrada fallÃ³:',e);
    process.exitCode=1;
  }finally{client.release();await pool.end();}
})();

