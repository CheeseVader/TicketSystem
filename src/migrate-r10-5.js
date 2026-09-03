require('dotenv').config();
const {Pool}=require('pg');
const pool=new Pool({connectionString:process.env.DATABASE_URL});

(async()=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN');

    // Campos requeridos por el flujo R10.5
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id)`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS status VARCHAR(30)`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_policy_id INTEGER REFERENCES sla_policies(id)`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS response_due_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_due_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS auto_close_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS wait_started_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS total_wait_seconds BIGINT NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS wait_reason TEXT`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalation_reason TEXT`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_notes TEXT`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closure_notes TEXT`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closure_type VARCHAR(20)`);
    await client.query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

    await client.query(`ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS sla_policy_id INTEGER REFERENCES sla_policies(id)`);
    await client.query(`ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);

    // Aceptar todos los estados R10.5 sin heredar checks antiguos.
    await client.query(`DO $$
      DECLARE r RECORD;
      BEGIN
        FOR r IN SELECT conname FROM pg_constraint
          WHERE conrelid='tickets'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%status%'
        LOOP EXECUTE format('ALTER TABLE tickets DROP CONSTRAINT %I',r.conname); END LOOP;
      END $$`);
    await client.query(`ALTER TABLE tickets ADD CONSTRAINT tickets_status_r10_5_chk
      CHECK (status IS NULL OR status IN ('assigned','in_progress','waiting','escalated','resolved','closed','cancelled'))`);

    await client.query(`DO $$
      DECLARE r RECORD;
      BEGIN
        FOR r IN SELECT conname FROM pg_constraint
          WHERE conrelid='support_requests'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%status%'
        LOOP EXECUTE format('ALTER TABLE support_requests DROP CONSTRAINT %I',r.conname); END LOOP;
      END $$`);
    await client.query(`ALTER TABLE support_requests ADD CONSTRAINT support_requests_status_r10_5_chk
      CHECK (status IN ('unassigned','assigned','in_progress','waiting','escalated','resolved','closed','cancelled'))`);

    // Garantizar SLA para solicitudes actuales sin política.
    await client.query(`
      UPDATE support_requests r
      SET sla_policy_id=(
        SELECT sp.id FROM sla_policies sp
        WHERE sp.enabled=TRUE
          AND (sp.department IS NULL OR sp.department=r.department)
          AND (sp.category IS NULL OR sp.category=r.category)
          AND (sp.station_id IS NULL OR sp.station_id=r.station_id)
          AND (sp.group_id IS NULL OR sp.group_id=(SELECT group_id FROM stations WHERE id=r.station_id))
        ORDER BY
          CASE WHEN sp.station_id=r.station_id THEN 1
               WHEN sp.group_id=(SELECT group_id FROM stations WHERE id=r.station_id) THEN 2 ELSE 3 END,
          CASE WHEN sp.department=r.department AND sp.category=r.category THEN 1
               WHEN sp.department=r.department AND sp.category IS NULL THEN 2
               WHEN sp.department IS NULL AND sp.category IS NULL THEN 3 ELSE 4 END,
          sp.priority,sp.id
        LIMIT 1
      )
      WHERE r.sla_policy_id IS NULL`);

    // Recalcular deadlines sólo cuando falten.
    await client.query(`
      UPDATE tickets t SET
        sla_policy_id=COALESCE(t.sla_policy_id,r.sla_policy_id)
      FROM support_requests r
      WHERE r.id=t.request_id AND t.sla_policy_id IS NULL`);

    await client.query(`
      UPDATE tickets t SET
        response_due_at=COALESCE(t.response_due_at,r.requested_at + make_interval(mins=>COALESCE(sp.response_minutes,5))),
        resolution_due_at=COALESCE(t.resolution_due_at,r.requested_at + make_interval(mins=>COALESCE(sp.resolution_minutes,60)))
      FROM support_requests r, sla_policies sp
      WHERE r.id=t.request_id AND sp.id=t.sla_policy_id`);

    await client.query('COMMIT');
    console.log('Migración R10.5 completada.');
  }catch(e){
    try{await client.query('ROLLBACK')}catch{}
    console.error('Migración R10.5 falló:',e);
    process.exitCode=1;
  }finally{
    client.release();
    await pool.end();
  }
})();