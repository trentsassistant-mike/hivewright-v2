-- EA-first decision pipeline.
-- Every system-generated decision is created with status='ea_review' and
-- handled by a dispatcher loop that spawns a headless EA agent to attempt
-- autonomous resolution. Owner-facing 'pending' is reserved for decisions
-- the EA explicitly chose to escalate.
--
-- Additive only — no existing rows are touched. Existing pending decisions
-- stay visible to the owner; new system decisions go through the EA first.

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS ea_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ea_reasoning text,
  ADD COLUMN IF NOT EXISTS ea_decided_at timestamp;

-- Ergonomic index for the dispatcher's poll loop ("find decisions waiting on
-- the EA") — partial index keeps it tiny since most rows will be 'resolved'.
CREATE INDEX IF NOT EXISTS decisions_ea_review_idx
  ON decisions (created_at)
  WHERE status = 'ea_review';
