BEGIN;

-- ============================================================
-- ANDON R11.2
-- Plantas + areas de soporte dinamicas + rol Supervisor
-- Migracion aditiva/idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS plants (
  id SERIAL PRIMARY KEY,
  code VARCHAR(40) UNIQUE NOT NULL,
  name VARCHAR(120) UNIQUE NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

INSERT INTO plants(code,name,sort_order,enabled) VALUES
 ('VESTA','VESTA',10,TRUE),
 ('OTAY','OTAY',20,TRUE)
ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name, enabled=TRUE, archived_at=NULL;

ALTER TABLE production_groups ADD COLUMN IF NOT EXISTS plant_id INTEGER REFERENCES plants(id);
UPDATE production_groups
SET plant_id=(SELECT id FROM plants WHERE code='VESTA' LIMIT 1)
WHERE plant_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_production_groups_plant ON production_groups(plant_id,enabled,sort_order);

CREATE TABLE IF NOT EXISTS support_departments (
  id SERIAL PRIMARY KEY,
  code VARCHAR(40) UNIQUE NOT NULL,
  name VARCHAR(120) UNIQUE NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

INSERT INTO support_departments(code,name,sort_order,enabled) VALUES
 ('systems','Sistemas',10,TRUE),
 ('maintenance','Mantenimiento',20,TRUE)
ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name, enabled=TRUE, archived_at=NULL;

-- Quitar checks historicos que limitaban rol/departamento a valores fijos.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conrelid::regclass AS tbl, conname
    FROM pg_constraint
    WHERE contype='c'
      AND conrelid IN (
        'users'::regclass,
        'support_categories'::regclass,
        'support_requests'::regclass,
        'tickets'::regclass,
        'sla_policies'::regclass,
        'admin_support_requests_catalog'::regclass
      )
      AND (pg_get_constraintdef(oid) ILIKE '%department%' OR pg_get_constraintdef(oid) ILIKE '%role%')
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',r.tbl,r.conname);
  END LOOP;
END $$;

-- Los códigos de área dejan de estar limitados al tamaño histórico de 20/30 caracteres.
ALTER TABLE users ALTER COLUMN department TYPE VARCHAR(40);
ALTER TABLE support_categories ALTER COLUMN department TYPE VARCHAR(40);
ALTER TABLE support_requests ALTER COLUMN department TYPE VARCHAR(40);
ALTER TABLE tickets ALTER COLUMN department TYPE VARCHAR(40);
ALTER TABLE sla_policies ALTER COLUMN department TYPE VARCHAR(40);
ALTER TABLE admin_support_requests_catalog ALTER COLUMN department TYPE VARCHAR(40);

ALTER TABLE users ADD CONSTRAINT users_role_r112_chk
  CHECK (role IN ('superadmin','admin','supervisor','engineer'));

-- Nuevas areas reciben una categoria generica para poder operar desde el primer momento.
INSERT INTO support_categories(department,code,label,icon,sort_order,enabled)
SELECT d.code,'other','Otro incidente','🛠️',999,TRUE
FROM support_departments d
WHERE NOT EXISTS (
  SELECT 1 FROM support_categories c WHERE c.department=d.code AND c.code='other'
);

INSERT INTO admin_support_requests_catalog(department,code,label,sort_order,enabled,category_group)
SELECT d.code,'other','Otro incidente',999,TRUE,'Otros'
FROM support_departments d
WHERE NOT EXISTS (
  SELECT 1 FROM admin_support_requests_catalog c WHERE c.department=d.code AND c.code='other'
);

COMMIT;
