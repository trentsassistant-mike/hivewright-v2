ALTER TABLE "hive_targets"
  ADD COLUMN IF NOT EXISTS "status" varchar(20) NOT NULL DEFAULT 'open';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'hive_targets' AND constraint_name = 'hive_targets_status_check'
  ) THEN
    ALTER TABLE "hive_targets"
      ADD CONSTRAINT "hive_targets_status_check"
      CHECK ("status" IN ('open', 'achieved', 'abandoned'));
  END IF;
END $$;
