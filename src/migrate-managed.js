require('dotenv').config();
const fs=require('fs');
const path=require('path');
const pool=require('./db');
(async()=>{
  const client=await pool.connect();
  try{
    for(const file of ['migrate-r11.sql','migrate-r11-2.sql','migrate-r11-4.sql']){
      const full=path.join(__dirname,'..','sql',file);
      if(!fs.existsSync(full)) continue;
      const sql=fs.readFileSync(full,'utf8').replace(/^\uFEFF/,'');
      console.log(`[DB] Aplicando ${file}...`);
      await client.query(sql);
    }
    console.log('[DB] Migraciones administradas completadas.');
  }catch(e){
    console.error('[DB] Migración administrada falló:',e);
    process.exitCode=1;
  }finally{client.release();await pool.end();}
})();
