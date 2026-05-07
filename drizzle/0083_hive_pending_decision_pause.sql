CREATE OR REPLACE FUNCTION "block_hive_pending_decision_when_paused"()
RETURNS trigger AS $$
DECLARE
  lock_reason text;
BEGIN
  IF NEW.status <> 'pending' THEN
    RETURN NEW;
  END IF;

  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT reason
    INTO lock_reason
    FROM hive_runtime_locks
   WHERE hive_id = NEW.hive_id
     AND creation_paused = true
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'HIVE_CREATION_PAUSED: decision escalation is paused for hive %: %',
      NEW.hive_id,
      COALESCE(lock_reason, 'No reason recorded')
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "decisions_hive_pending_pause_guard" ON "decisions";
CREATE TRIGGER "decisions_hive_pending_pause_guard"
BEFORE UPDATE OF status ON "decisions"
FOR EACH ROW EXECUTE FUNCTION "block_hive_pending_decision_when_paused"();
