BEGIN;

ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'station';
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS requester_area VARCHAR(100);
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS support_location VARCHAR(160);
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS admin_request_type VARCHAR(80);
ALTER TABLE support_requests ALTER COLUMN station_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS support_areas (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_locations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_support_requests_catalog (
  id SERIAL PRIMARY KEY,
  department VARCHAR(20) NOT NULL CHECK (department IN ('systems','maintenance')),
  code VARCHAR(80) NOT NULL,
  label VARCHAR(140) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(department,code)
);

INSERT INTO support_areas(name,sort_order) VALUES
 ('Production',10),('Engineering',20),('Quality',30),('Warehouse',40),('HR',50),
 ('Finance',60),('Purchasing',70),('Planning',80),('IT',90),('Security Booth',100),('Electric Test',110),('Logistic',120),('Otros',999)
ON CONFLICT(name) DO NOTHING;

INSERT INTO support_locations(name,sort_order)
SELECT name,sort_order FROM (VALUES
 ('Oficinas',10),('V1',20),('V2',30),('V3',40),('Warehouse',50),('Security Booth',60),('Otros',999)
) AS x(name,sort_order)
ON CONFLICT(name) DO NOTHING;

INSERT INTO admin_support_requests_catalog(department,code,label,sort_order) VALUES
 ('systems','computer','Problema con computadora / laptop',10),
 ('systems','monitor','Problema con monitor',20),
 ('systems','printer','Problema con impresora',30),
 ('systems','scanner','Problema con escaner',40),
 ('systems','pda','Problema con PDA',50),
 ('systems','email','Correo / Outlook',60),
 ('systems','office','Microsoft Office',70),
 ('systems','teams','Microsoft Teams',80),
 ('systems','smes','SMES',90),
 ('systems','pes','PES',100),
 ('systems','sfera','Sfera',110),
 ('systems','password','Contrasena / cuenta bloqueada',120),
 ('systems','access','Accesos / permisos',130),
 ('systems','network','Red / Internet / Wi-Fi',140),
 ('systems','other','Otros',999),
 ('maintenance','electrical','Problema electrico',10),
 ('maintenance','mechanical','Problema mecanico',20),
 ('maintenance','facility','Instalaciones / infraestructura',30),
 ('maintenance','other','Otros',999)
ON CONFLICT(department,code) DO UPDATE SET label=EXCLUDED.label,sort_order=EXCLUDED.sort_order;

COMMIT;
