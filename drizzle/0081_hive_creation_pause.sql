CREATE TABLE IF NOT EXISTS "hive_runtime_locks" (
  "hive_id" uuid PRIMARY KEY REFERENCES "hives"("id") ON DELETE CASCADE,
  "creation_paused" boolean NOT NULL DEFAULT false,
  "reason" text,
  "paused_by" text,
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION "block_hive_creation_when_paused"()
RETURNS trigger AS $$
DECLARE
  lock_reason text;
BEGIN
  SELECT reason
    INTO lock_reason
    FROM hive_runtime_locks
   WHERE hive_id = NEW.hive_id
     AND creation_paused = true
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'HIVE_CREATION_PAUSED: creation is paused for hive %: %',
      NEW.hive_id,
      COALESCE(lock_reason, 'No reason recorded')
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "tasks_hive_creation_pause_guard" ON "tasks";
CREATE TRIGGER "tasks_hive_creation_pause_guard"
BEFORE INSERT ON "tasks"
FOR EACH ROW EXECUTE FUNCTION "block_hive_creation_when_paused"();

DROP TRIGGER IF EXISTS "goals_hive_creation_pause_guard" ON "goals";
CREATE TRIGGER "goals_hive_creation_pause_guard"
BEFORE INSERT ON "goals"
FOR EACH ROW EXECUTE FUNCTION "block_hive_creation_when_paused"();

DROP TRIGGER IF EXISTS "decisions_hive_creation_pause_guard" ON "decisions";
CREATE TRIGGER "decisions_hive_creation_pause_guard"
BEFORE INSERT ON "decisions"
FOR EACH ROW EXECUTE FUNCTION "block_hive_creation_when_paused"();
