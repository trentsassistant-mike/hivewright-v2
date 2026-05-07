ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS fresh_input_tokens integer,
  ADD COLUMN IF NOT EXISTS cached_input_tokens integer,
  ADD COLUMN IF NOT EXISTS cached_input_tokens_known boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS total_context_tokens integer,
  ADD COLUMN IF NOT EXISTS estimated_billable_cost_cents integer;

ALTER TABLE supervisor_reports
  ADD COLUMN IF NOT EXISTS fresh_input_tokens integer,
  ADD COLUMN IF NOT EXISTS cached_input_tokens integer,
  ADD COLUMN IF NOT EXISTS cached_input_tokens_known boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS total_context_tokens integer,
  ADD COLUMN IF NOT EXISTS estimated_billable_cost_cents integer;

UPDATE tasks
SET
  fresh_input_tokens = COALESCE(fresh_input_tokens, tokens_input),
  cached_input_tokens = COALESCE(cached_input_tokens, 0),
  cached_input_tokens_known = COALESCE(cached_input_tokens_known, false),
  total_context_tokens = COALESCE(total_context_tokens, tokens_input),
  estimated_billable_cost_cents = COALESCE(estimated_billable_cost_cents, cost_cents)
WHERE tokens_input IS NOT NULL
   OR cost_cents IS NOT NULL;

UPDATE supervisor_reports
SET
  fresh_input_tokens = COALESCE(fresh_input_tokens, tokens_input),
  cached_input_tokens = COALESCE(cached_input_tokens, 0),
  cached_input_tokens_known = COALESCE(cached_input_tokens_known, false),
  total_context_tokens = COALESCE(total_context_tokens, tokens_input),
  estimated_billable_cost_cents = COALESCE(estimated_billable_cost_cents, cost_cents)
WHERE tokens_input IS NOT NULL
   OR cost_cents IS NOT NULL;
