ALTER TABLE goals
  ADD COLUMN IF NOT EXISTS outcome_classification varchar(32),
  ADD COLUMN IF NOT EXISTS outcome_classification_rationale text,
  ADD COLUMN IF NOT EXISTS outcome_process_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS outcome_classified_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome_classified_by varchar(255);

UPDATE goals
SET outcome_process_references = '[]'::jsonb
WHERE outcome_process_references IS NULL;

ALTER TABLE goal_completions
  ADD COLUMN IF NOT EXISTS learning_gate jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE goal_completions
SET learning_gate = '{}'::jsonb
WHERE learning_gate IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'goals_outcome_classification_check'
  ) THEN
    ALTER TABLE goals
      ADD CONSTRAINT goals_outcome_classification_check
      CHECK (
        outcome_classification IS NULL
        OR outcome_classification IN ('outcome-led', 'process-bound')
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'goal_completions_learning_gate_object_check'
  ) THEN
    ALTER TABLE goal_completions
      ADD CONSTRAINT goal_completions_learning_gate_object_check
      CHECK (jsonb_typeof(learning_gate) = 'object');
  END IF;
END $$;
