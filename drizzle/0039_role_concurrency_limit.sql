-- Per-role concurrency limit. Replaces the hardcoded 1-at-a-time
-- per-role serialisation in the task-claimer SQL. OpenClaw's
-- single-session-file constraint motivated the original cap;
-- OpenClaw is retired so the cap is now configurable per role.

ALTER TABLE role_templates
  ADD COLUMN IF NOT EXISTS concurrency_limit integer NOT NULL DEFAULT 1;

-- Seed sensible defaults for executor roles. Goal-supervisor is set to
-- a high value but is exempted in the claim SQL anyway. Doctor stays at
-- 1 because doctor diagnoses are inherently sequential per failed task.
-- QA at 2 (multiple reviews can run in parallel). Dev/security/research
-- at 3 (the throughput unlock for today's bottleneck).
UPDATE role_templates SET concurrency_limit = 50 WHERE slug = 'goal-supervisor';
UPDATE role_templates SET concurrency_limit = 1  WHERE slug IN ('doctor', 'hive-supervisor');
UPDATE role_templates SET concurrency_limit = 3  WHERE slug IN ('dev-agent', 'security-auditor', 'research-analyst', 'design-agent', 'data-analyst', 'content-writer', 'design-agent', 'infrastructure-agent', 'code-review-agent', 'qa', 'content-review-agent');
-- Anything else stays at 1 by default; owner can bump via the Roles dashboard.
