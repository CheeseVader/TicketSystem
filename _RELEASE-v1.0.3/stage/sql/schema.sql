CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(60) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  role VARCHAR(30) NOT NULL CHECK (role IN ('systems','maintenance','superadmin')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stations (
  id SERIAL PRIMARY KEY,
  code VARCHAR(20) UNIQUE NOT NULL,
  line_no INTEGER NOT NULL CHECK (line_no BETWEEN 1 AND 99),
  station_no INTEGER NOT NULL CHECK (station_no BETWEEN 1 AND 99),
  label VARCHAR(80),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE(line_no, station_no)
);

CREATE TABLE IF NOT EXISTS support_categories (
  id SERIAL PRIMARY KEY,
  department VARCHAR(30) NOT NULL CHECK (department IN ('systems','maintenance')),
  code VARCHAR(50) NOT NULL,
  label VARCHAR(80) NOT NULL,
  icon VARCHAR(16),
  sort_order INTEGER NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE(department, code)
);

CREATE TABLE IF NOT EXISTS support_requests (
  id BIGSERIAL PRIMARY KEY,
  station_id INTEGER NOT NULL REFERENCES stations(id),
  department VARCHAR(30) NOT NULL CHECK (department IN ('systems','maintenance')),
  category VARCHAR(50),
  status VARCHAR(30) NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','attending','resolved')),
  requested_by VARCHAR(120) DEFAULT 'Operador',
  notes TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attended_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  attended_by INTEGER REFERENCES users(id),
  resolved_by INTEGER REFERENCES users(id)
);

-- Migracion segura para instalaciones R1 ya existentes.
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS category VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_requests_status ON support_requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_station ON support_requests(station_id);
CREATE INDEX IF NOT EXISTS idx_requests_department ON support_requests(department);
CREATE INDEX IF NOT EXISTS idx_requests_category ON support_requests(category);

CREATE UNIQUE INDEX IF NOT EXISTS uq_active_request_station_department
ON support_requests(station_id, department)
WHERE status IN ('requested','attending');

INSERT INTO support_categories(department,code,label,icon,sort_order,enabled) VALUES
  ('systems','smes','SMES','🏭',10,TRUE),
  ('systems','printer','IMPRESORA','🖨️',20,TRUE),
  ('systems','pc','PC','🖥️',30,TRUE),
  ('systems','other','OTROS','⋯',40,TRUE),
  ('maintenance','strap','STRAP','🔧',10,TRUE),
  ('maintenance','other','OTROS','⋯',20,TRUE)
ON CONFLICT(department,code) DO UPDATE SET
  label=EXCLUDED.label,
  icon=EXCLUDED.icon,
  sort_order=EXCLUDED.sort_order,
  enabled=EXCLUDED.enabled;
