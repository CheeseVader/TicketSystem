BEGIN;

CREATE TABLE IF NOT EXISTS production_groups (
  id SERIAL PRIMARY KEY,
  code VARCHAR(30) UNIQUE NOT NULL,
  name VARCHAR(120) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  legacy_line_no INTEGER UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE stations ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES production_groups(id);
ALTER TABLE stations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

INSERT INTO production_groups(code,name,sort_order,legacy_line_no,enabled) VALUES
('LINE1','Línea 1',10,1,TRUE),('LINE2','Línea 2',20,2,TRUE),('LINE3','Línea 3',30,3,TRUE)
ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name, legacy_line_no=EXCLUDED.legacy_line_no;

UPDATE stations s SET group_id=g.id
FROM production_groups g
WHERE s.group_id IS NULL AND g.legacy_line_no=s.line_no;

CREATE TABLE IF NOT EXISTS tickets (
  id BIGSERIAL PRIMARY KEY,
  ticket_number VARCHAR(40) UNIQUE,
  request_id BIGINT UNIQUE NOT NULL REFERENCES support_requests(id),
  department VARCHAR(30) NOT NULL CHECK (department IN ('systems','maintenance')),
  station_code VARCHAR(30) NOT NULL,
  station_name VARCHAR(120),
  group_name VARCHAR(120),
  category VARCHAR(50),
  category_label VARCHAR(80),
  description TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tickets_department ON tickets(department);
CREATE INDEX IF NOT EXISTS idx_tickets_resolved_at ON tickets(resolved_at DESC);
CREATE INDEX IF NOT EXISTS idx_stations_group ON stations(group_id);

-- Crear tickets para solicitudes históricas ya resueltas que aún no tengan ticket.
INSERT INTO tickets(request_id,department,station_code,station_name,group_name,category,category_label,description,resolved_by,resolved_at)
SELECT r.id,r.department,s.code,s.label,g.name,r.category,c.label,r.notes,r.resolved_by,COALESCE(r.resolved_at,NOW())
FROM support_requests r
JOIN stations s ON s.id=r.station_id
LEFT JOIN production_groups g ON g.id=s.group_id
LEFT JOIN support_categories c ON c.department=r.department AND c.code=r.category
LEFT JOIN tickets t ON t.request_id=r.id
WHERE r.status='resolved' AND t.id IS NULL;

UPDATE tickets
SET ticket_number=(CASE WHEN department='systems' THEN 'SYS' ELSE 'MNT' END)||'-'||TO_CHAR(resolved_at,'YYYYMMDD')||'-'||LPAD(id::text,6,'0')
WHERE ticket_number IS NULL;

COMMIT;
