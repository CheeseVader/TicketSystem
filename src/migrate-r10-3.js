require('dotenv').config();
const {Pool}=require('pg');
const pool=new Pool({connectionString:process.env.DATABASE_URL});
(async()=>{
  try{
    await pool.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closure_notes TEXT;`);
    console.log('Migración R10.3 completada: closure_notes disponible.');
  }catch(e){
    console.error('Migración R10.3 falló:',e);
    process.exitCode=1;
  }finally{
    await pool.end();
  }
})();