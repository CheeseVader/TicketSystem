require('dotenv').config();
const fs=require('fs');
const path=require('path');
const pool=require('./db');

(async()=>{
  try{
    let sql=fs.readFileSync(path.join(__dirname,'..','sql','migrate-r1.8.7-p3-plants-users-areas.sql'),'utf8');
    sql=sql.replace(/^\uFEFF/,'');
    await pool.query(sql);

    const cols=(await pool.query(`
      SELECT table_name,column_name
      FROM information_schema.columns
      WHERE table_schema='public'
        AND (
          (table_name='users' AND column_name='plant_id')
          OR
          (table_name='support_areas' AND column_name='plant_id')
        )
      ORDER BY table_name,column_name
    `)).rows;

    if(!cols.some(x=>x.table_name==='users'&&x.column_name==='plant_id'))
      throw new Error('Falta users.plant_id');
    if(!cols.some(x=>x.table_name==='support_areas'&&x.column_name==='plant_id'))
      throw new Error('Falta support_areas.plant_id');

    const fks=(await pool.query(`
      SELECT
        tc.table_name,
        kcu.column_name,
        ccu.table_name AS foreign_table,
        ccu.column_name AS foreign_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name=kcu.constraint_name
       AND tc.constraint_schema=kcu.constraint_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name=tc.constraint_name
       AND ccu.constraint_schema=tc.constraint_schema
      WHERE tc.constraint_type='FOREIGN KEY'
        AND tc.table_schema='public'
        AND tc.table_name IN ('users','support_areas')
        AND kcu.column_name='plant_id'
    `)).rows;

    const expected = [
      ['users','plant_id','plants','id'],
      ['support_areas','plant_id','plants','id']
    ];
    for(const [t,c,pt,pc] of expected){
      if(!fks.some(x=>x.table_name===t&&x.column_name===c&&x.foreign_table===pt&&x.foreign_column===pc)){
        throw new Error(`Falta FK ${t}.${c} -> ${pt}.${pc}`);
      }
    }

    console.log('[OK] users.plant_id');
    console.log('[OK] support_areas.plant_id');
    console.log('[OK] FK users.plant_id -> plants.id');
    console.log('[OK] FK support_areas.plant_id -> plants.id');
  }catch(e){
    console.error(e.stack||e);
    process.exitCode=1;
  }finally{
    try{await pool.end()}catch{}
  }
})();