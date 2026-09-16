BEGIN;

-- ============================================================
-- R10.1: roles, SLA, tickets operativos, aliases y auditoría
-- ============================================================

-- 1) USUARIOS / ROLES
ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(30);
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid='users'::regclass
      AND contype='c'
      AND pg_get_constraintdef(oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

UPDATE users SET department='systems', role='engineer' WHERE role='systems';
UPDATE users SET department='maintenance', role='engineer' WHERE role='maintenance';
UPDATE users SET department=NULL WHERE role IN ('superadmin','admin');

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_department_r10_chk;
ALTER TABLE users ADD CONSTRAINT users_role_r10_chk CHECK (role IN ('superadmin','admin','engineer'));
ALTER TABLE users ADD CONSTRAINT users_department_r10_chk CHECK (department IS NULL OR department IN ('systems','maintenance'));

-- 2) GRUPOS / ESTACIONES Y ALIASES
ALTER TABLE production_groups ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE production_groups ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE stations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE stations ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS station_aliases (
  id BIGSERIAL PRIMARY KEY,
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  old_code VARCHAR(80) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_station_alias_station ON station_aliases(station_id);

-- 3) POLÍTICAS SLA
CREATE TABLE IF NOT EXISTS sla_policies (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  department VARCHAR(30) CHECK (department IS NULL OR department IN ('systems','maintenance')),
  category VARCHAR(50),
  group_id INTEGER REFERENCES production_groups(id),
  station_id INTEGER REFERENCES stations(id),
  response_minutes INTEGER NOT NULL DEFAULT 5 CHECK (response_minutes > 0),
  resolution_minutes INTEGER NOT NULL DEFAULT 60 CHECK (resolution_minutes > 0),
  autoclose_minutes INTEGER NOT NULL DEFAULT 10 CHECK (autoclose_minutes >= 1),
  pause_on_waiting BOOLEAN NOT NULL DEFAULT TRUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE sla_policies ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES production_groups(id);
ALTER TABLE sla_policies ADD COLUMN IF NOT EXISTS station_id INTEGER REFERENCES stations(id);
CREATE INDEX IF NOT EXISTS idx_sla_match ON sla_policies(enabled,department,category,group_id,station_id,priority);

INSERT INTO sla_policies(name,department,category,response_minutes,resolution_minutes,autoclose_minutes,pause_on_waiting,priority)
SELECT 'SLA General',NULL,NULL,5,60,10,TRUE,999
WHERE NOT EXISTS (SELECT 1 FROM sla_policies WHERE department IS NULL AND category IS NULL AND group_id IS NULL AND station_id IS NULL AND enabled=TRUE);

-- 4) SOLICITUDES: nuevos estados y snapshot SLA
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid='support_requests'::regclass
      AND contype='c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE support_requests DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

UPDATE support_requests SET status='unassigned' WHERE status='requested';
UPDATE support_requests SET status='in_progress' WHERE status='attending';

ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS sla_policy_id INTEGER REFERENCES sla_policies(id);
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE support_requests ADD CONSTRAINT support_requests_status_r10_chk
  CHECK (status IN ('unassigned','assigned','in_progress','waiting','escalated','resolved','closed','cancelled'));

UPDATE support_requests
SET assigned_at=COALESCE(assigned_at,attended_at)
WHERE status IN ('assigned','in_progress','waiting','escalated','resolved','closed') AND assigned_at IS NULL;

-- 5) TICKETS: nacen AL ASIGNARSE, no al resolverse
ALTER TABLE tickets ALTER COLUMN resolved_at DROP NOT NULL;
ALTER TABLE tickets ALTER COLUMN resolved_at DROP DEFAULT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES users(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS status VARCHAR(30);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_policy_id INTEGER REFERENCES sla_policies(id);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS response_due_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_due_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS auto_close_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS wait_started_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS total_wait_seconds BIGINT NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS wait_reason TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalation_reason TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_notes TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS closure_type VARCHAR(20);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE tickets t SET
  assigned_to=COALESCE(t.assigned_to,r.attended_by,r.resolved_by),
  assigned_at=COALESCE(t.assigned_at,r.attended_at,r.requested_at),
  status=COALESCE(t.status,CASE WHEN r.status='closed' THEN 'closed' ELSE 'resolved' END),
  closed_at=COALESCE(t.closed_at,r.closed_at),
  closure_type=COALESCE(t.closure_type,CASE WHEN r.status='closed' THEN 'legacy' END)
FROM support_requests r WHERE r.id=t.request_id;

-- Crear tickets para solicitudes ya asignadas/en progreso que en R9 todavía no tenían ticket.
INSERT INTO tickets(request_id,department,station_code,station_name,group_name,category,category_label,description,
                    assigned_to,assigned_at,status,resolved_by,resolved_at,created_at)
SELECT r.id,r.department,s.code,s.label,g.name,r.category,c.label,r.notes,
       COALESCE(r.attended_by,r.resolved_by),COALESCE(r.assigned_at,r.attended_at,r.requested_at),
       CASE r.status
         WHEN 'resolved' THEN 'resolved'
         WHEN 'closed' THEN 'closed'
         WHEN 'waiting' THEN 'waiting'
         WHEN 'escalated' THEN 'escalated'
         WHEN 'assigned' THEN 'assigned'
         ELSE 'in_progress'
       END,
       r.resolved_by,r.resolved_at,COALESCE(r.attended_at,r.requested_at)
FROM support_requests r
JOIN stations s ON s.id=r.station_id
LEFT JOIN production_groups g ON g.id=s.group_id
LEFT JOIN support_categories c ON c.department=r.department AND c.code=r.category
LEFT JOIN tickets t ON t.request_id=r.id
WHERE r.status IN ('assigned','in_progress','waiting','escalated','resolved','closed') AND t.id IS NULL;

UPDATE tickets
SET ticket_number=(CASE WHEN department='systems' THEN 'SYS' ELSE 'MNT' END)||'-'||TO_CHAR(COALESCE(assigned_at,created_at),'YYYYMMDD')||'-'||LPAD(id::text,6,'0')
WHERE ticket_number IS NULL;

-- Asignar SLA general a registros sin política y calcular fechas objetivo.
UPDATE support_requests r
SET sla_policy_id=(SELECT id FROM sla_policies WHERE enabled=TRUE AND department IS NULL AND category IS NULL ORDER BY priority,id LIMIT 1)
WHERE sla_policy_id IS NULL;

UPDATE tickets t SET sla_policy_id=COALESCE(t.sla_policy_id,r.sla_policy_id)
FROM support_requests r WHERE r.id=t.request_id AND t.sla_policy_id IS NULL;

UPDATE tickets t SET
 response_due_at=COALESCE(t.response_due_at,r.requested_at + make_interval(mins=>s.response_minutes)),
 resolution_due_at=COALESCE(t.resolution_due_at,r.requested_at + make_interval(mins=>s.resolution_minutes)),
 auto_close_at=CASE
   WHEN t.status='resolved'
   THEN COALESCE(t.auto_close_at,t.resolved_at + make_interval(mins=>s.autoclose_minutes))
   ELSE t.auto_close_at
 END
FROM support_requests r, sla_policies s
WHERE r.id=t.request_id
  AND s.id=t.sla_policy_id;

-- 6) EVENTOS / AUDITORÍA DE TICKET
CREATE TABLE IF NOT EXISTS ticket_events (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  event_type VARCHAR(40) NOT NULL,
  old_status VARCHAR(30),
  new_status VARCHAR(30),
  user_id INTEGER REFERENCES users(id),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events(ticket_id,created_at);

-- 7) PROTECCIÓN DE ÍNDICES
CREATE INDEX IF NOT EXISTS idx_requests_status_department ON support_requests(status,department,requested_at);
CREATE INDEX IF NOT EXISTS idx_tickets_status_department ON tickets(status,department,updated_at);
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_to ON tickets(assigned_to,status);

COMMIT;
