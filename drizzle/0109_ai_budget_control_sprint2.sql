ALTER TABLE goals
  ADD COLUMN IF NOT EXISTS budget_state varchar(32) DEFAULT 'ok' NOT NULL,
  ADD COLUMN IF NOT EXISTS budget_warning_triggered_at timestamptz,
  ADD COLUMN IF NOT EXISTS budget_enforced_at timestamptz,
  ADD COLUMN IF NOT EXISTS budget_enforcement_reason text;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS usage_details jsonb;

ALTER TABLE work_products
  ADD COLUMN IF NOT EXISTS usage_details jsonb;
