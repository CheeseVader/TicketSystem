BEGIN;

-- ANDON R11.4: contexto de planta y línea para solicitudes del portal administrativo.
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS plant_id INTEGER REFERENCES plants(id) ON DELETE SET NULL;
ALTER TABLE support_requests ADD COLUMN IF NOT EXISTS support_group_id INTEGER REFERENCES production_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_support_requests_plant ON support_requests(plant_id,requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_requests_support_group ON support_requests(support_group_id,requested_at DESC);

-- Backfill seguro para solicitudes ligadas a una estación.
UPDATE support_requests r
SET plant_id=g.plant_id, support_group_id=g.id
FROM stations s JOIN production_groups g ON g.id=s.group_id
WHERE r.station_id=s.id AND (r.plant_id IS NULL OR r.support_group_id IS NULL);

COMMIT;
