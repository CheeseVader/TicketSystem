BEGIN;

-- ============================================================
-- R11: Layout visual 20 x 2 por grupo de produccion
-- Migracion aditiva e idempotente. No modifica station_no.
-- ============================================================

ALTER TABLE stations ADD COLUMN IF NOT EXISTS layout_row INTEGER;
ALTER TABLE stations ADD COLUMN IF NOT EXISTS layout_col INTEGER;

ALTER TABLE stations DROP CONSTRAINT IF EXISTS stations_layout_row_r11_chk;
ALTER TABLE stations DROP CONSTRAINT IF EXISTS stations_layout_col_r11_chk;
ALTER TABLE stations ADD CONSTRAINT stations_layout_row_r11_chk CHECK (layout_row IS NULL OR layout_row BETWEEN 1 AND 2);
ALTER TABLE stations ADD CONSTRAINT stations_layout_col_r11_chk CHECK (layout_col IS NULL OR layout_col BETWEEN 1 AND 20);

-- Una posicion solo puede pertenecer a una estacion activa/no archivada del grupo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_stations_group_layout_r11
ON stations(group_id,layout_row,layout_col)
WHERE archived_at IS NULL AND layout_row IS NOT NULL AND layout_col IS NOT NULL;

-- Asigna posiciones iniciales unicamente a estaciones que aun no tengan layout.
-- Respeta cualquier posicion ya guardada y busca el primer espacio libre.
DO $$
DECLARE
  st RECORD;
  r INTEGER;
  c INTEGER;
  placed BOOLEAN;
BEGIN
  FOR st IN
    SELECT s.id,s.group_id
    FROM stations s
    LEFT JOIN production_groups g ON g.id=s.group_id
    WHERE s.archived_at IS NULL
      AND s.group_id IS NOT NULL
      AND (s.layout_row IS NULL OR s.layout_col IS NULL)
    ORDER BY g.sort_order,s.station_no,s.id
  LOOP
    placed := FALSE;
    FOR r IN 1..2 LOOP
      FOR c IN 1..20 LOOP
        IF NOT EXISTS (
          SELECT 1 FROM stations x
          WHERE x.group_id=st.group_id
            AND x.archived_at IS NULL
            AND x.layout_row=r
            AND x.layout_col=c
            AND x.id<>st.id
        ) THEN
          UPDATE stations SET layout_row=r,layout_col=c,updated_at=NOW() WHERE id=st.id;
          placed := TRUE;
          EXIT;
        END IF;
      END LOOP;
      EXIT WHEN placed;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
