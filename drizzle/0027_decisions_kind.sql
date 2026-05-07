-- Split decisions table into two logical queues: owner judgement calls
-- ('decision') vs infrastructure failures that shouldn't page the owner
-- ('system_error'). Default 'decision' keeps every existing row in its
-- current queue; the dispatcher's escalation paths classify new rows
-- by failure reason via src/decisions/classify-failure-reason.ts.

ALTER TABLE decisions
  ADD COLUMN IF NOT EXISTS kind varchar(50) NOT NULL DEFAULT 'decision';

CREATE INDEX IF NOT EXISTS idx_decisions_kind_status ON decisions (kind, status);
