ALTER TABLE hives
  ADD COLUMN IF NOT EXISTS ai_budget_cap_cents integer,
  ADD COLUMN IF NOT EXISTS ai_budget_window varchar(32) DEFAULT 'all_time' NOT NULL;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS budget_cents integer,
  ADD COLUMN IF NOT EXISTS spent_cents integer DEFAULT 0 NOT NULL;

CREATE TABLE IF NOT EXISTS budget_controls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hive_id uuid NOT NULL REFERENCES hives(id) ON DELETE CASCADE,
  scope varchar(32) NOT NULL,
  scope_id uuid,
  cap_cents integer NOT NULL,
  budget_window varchar(32) DEFAULT 'all_time' NOT NULL,
  currency varchar(8) DEFAULT 'USD' NOT NULL,
  created_at timestamptz DEFAULT NOW() NOT NULL,
  updated_at timestamptz DEFAULT NOW() NOT NULL,
  CONSTRAINT budget_controls_scope_check CHECK (scope IN ('hive', 'outcome', 'goal', 'task')),
  CONSTRAINT budget_controls_window_check CHECK (budget_window IN ('daily', 'weekly', 'monthly', 'all_time')),
  CONSTRAINT budget_controls_cap_nonnegative CHECK (cap_cents >= 0),
  CONSTRAINT budget_controls_hive_scope_id_check CHECK ((scope = 'hive' AND scope_id IS NULL) OR (scope <> 'hive' AND scope_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS budget_controls_scope_unique
  ON budget_controls (hive_id, scope, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));
