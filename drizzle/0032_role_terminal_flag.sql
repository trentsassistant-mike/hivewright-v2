-- Add a library-level `terminal` flag to role_templates. Terminal roles are
-- those whose completed tasks are not expected to produce follow-up work:
-- watchdogs (hive-supervisor), system plumbing (qa, doctor, goal-supervisor),
-- and analysis-only executors (research-analyst, design-agent). The Hive
-- Supervisor's `unsatisfied_completion` and `orphan_output` detectors use
-- this flag to suppress false positives that previously self-referenced
-- every heartbeat and every analysis deliverable. Idempotent.
ALTER TABLE role_templates
  ADD COLUMN IF NOT EXISTS terminal BOOLEAN NOT NULL DEFAULT false;
