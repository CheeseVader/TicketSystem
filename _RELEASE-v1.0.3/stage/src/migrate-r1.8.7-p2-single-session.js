require('dotenv').config();
const fs=require('fs');
const path=require('path');
const pool=require('./db');

(async()=>{
  try{
    let sql=fs.readFileSync(path.join(__dirname,'..','sql','migrate-r1.8.7-p2-single-session.sql'),'utf8');
    sql=sql.replace(/^\uFEFF/,'');
    await pool.query(sql);

    const {rows}=await pool.query(`
      SELECT
        tc.constraint_name,
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name=kcu.constraint_name
       AND tc.constraint_schema=kcu.constraint_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name=tc.constraint_name
       AND ccu.constraint_schema=tc.constraint_schema
      WHERE tc.constraint_type='FOREIGN KEY'
        AND tc.table_schema='public'
        AND tc.table_name='active_user_sessions'
    `);

    if(!rows.some(r=>r.column_name==='user_id' && r.foreign_table_name==='users' && r.foreign_column_name==='id')){
      throw new Error('No se creo FK active_user_sessions.user_id -> users.id');
    }
    console.log('[OK] Migracion P2 aplicada y FK validada.');
  }catch(e){
    console.error(e.stack||e);
    process.exitCode=1;
  }finally{
    try{await pool.end()}catch{}
  }
})();