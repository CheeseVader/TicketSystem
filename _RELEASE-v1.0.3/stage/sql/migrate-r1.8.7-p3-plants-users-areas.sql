BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS plant_id BIGINT;

ALTER TABLE support_areas
  ADD COLUMN IF NOT EXISTS plant_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname='fk_users_plant'
      AND conrelid='users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT fk_users_plant
      FOREIGN KEY(plant_id) REFERENCES plants(id)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname='fk_support_areas_plant'
      AND conrelid='support_areas'::regclass
  ) THEN
    ALTER TABLE support_areas
      ADD CONSTRAINT fk_support_areas_plant
      FOREIGN KEY(plant_id) REFERENCES plants(id)
      ON UPDATE CASCADE
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_plant_id
  ON users(plant_id);

CREATE INDEX IF NOT EXISTS idx_support_areas_plant_id
  ON support_areas(plant_id);

COMMIT;