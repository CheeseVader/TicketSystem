require('dotenv').config();
const {Pool}=require('pg');
const pool=new Pool({connectionString:process.env.DATABASE_URL});
(async()=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closure_notes TEXT`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_notes TEXT`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closure_type VARCHAR(20)`);
    await client.query(`ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`);
    await client.query(`DO $$
      DECLARE r RECORD;
      BEGIN
        FOR r IN SELECT conname FROM pg_constraint
          WHERE conrelid='support_requests'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%status%'
        LOOP EXECUTE format('ALTER TABLE support_requests DROP CONSTRAINT %I',r.conname); END LOOP;
      END $$;`);
    await client.query(`ALTER TABLE support_requests ADD CONSTRAINT support_requests_status_r10_4_chk CHECK (status IN ('unassigned','assigned','in_progress','waiting','escalated','resolved','closed','cancelled'))`);
    await client.query('COMMIT');
    console.log('Migración R10.4 completada.');
  }catch(e){
    await client.query('ROLLBACK');
    console.error('Migración R10.4 falló:',e);
    process.exitCode=1;
  }finally{client.release();await pool.end();}
})();
