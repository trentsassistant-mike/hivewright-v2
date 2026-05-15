DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'hives' AND column_name = 'pilot_ai_budget_cap_cents'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'hives' AND column_name = 'ai_budget_cap_cents'
  ) THEN
    ALTER TABLE hives RENAME COLUMN pilot_ai_budget_cap_cents TO ai_budget_cap_cents;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'hives' AND column_name = 'pilot_ai_budget_window'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'hives' AND column_name = 'ai_budget_window'
  ) THEN
    ALTER TABLE hives RENAME COLUMN pilot_ai_budget_window TO ai_budget_window;
  END IF;
END $$;
