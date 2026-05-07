-- Insight curator: tracks why each insight reached its terminal status,
-- when the curator last touched it, and (for escalations) the decision row
-- it spawned. All columns are nullable + idempotent so re-running is safe.

ALTER TABLE insights
  ADD COLUMN IF NOT EXISTS curator_reason text,
  ADD COLUMN IF NOT EXISTS curated_at timestamp,
  ADD COLUMN IF NOT EXISTS decision_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'insights' AND constraint_name = 'insights_decision_id_fkey'
  ) THEN
    ALTER TABLE insights
      ADD CONSTRAINT insights_decision_id_fkey
      FOREIGN KEY (decision_id) REFERENCES decisions(id) ON DELETE SET NULL;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_insights_status_hive ON insights (status, hive_id);
