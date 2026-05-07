ALTER TABLE decisions
ADD COLUMN IF NOT EXISTS is_qa_fixture boolean NOT NULL DEFAULT false;

ALTER TABLE task_quality_signals
ADD COLUMN IF NOT EXISTS is_qa_fixture boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS decisions_qa_fixture_idx
ON decisions (is_qa_fixture, hive_id, status, kind, created_at);

CREATE INDEX IF NOT EXISTS task_quality_signals_qa_fixture_idx
ON task_quality_signals (is_qa_fixture, hive_id, task_id, created_at);
