-- Hive Supervisor (work-integrity watchdog): adds the supervisor_reports
-- audit table and seeds a default 15-minute heartbeat schedule for every
-- existing hive so the supervisor starts running on deploy without manual
-- intervention. Idempotent — safe to re-apply via the OUT_OF_JOURNAL replay
-- path in scripts/setup-test-db.ts.

CREATE TABLE IF NOT EXISTS "supervisor_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hive_id" uuid NOT NULL,
  "ran_at" timestamp DEFAULT now() NOT NULL,
  "report" jsonb NOT NULL,
  "actions" jsonb,
  "action_outcomes" jsonb,
  "agent_task_id" uuid,
  "tokens_input" integer,
  "tokens_output" integer,
  "cost_cents" integer,
  CONSTRAINT "supervisor_reports_hive_id_fkey"
    FOREIGN KEY ("hive_id") REFERENCES "hives"("id") ON DELETE CASCADE,
  CONSTRAINT "supervisor_reports_agent_task_id_fkey"
    FOREIGN KEY ("agent_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "supervisor_reports_hive_id_ran_at_idx"
  ON "supervisor_reports" ("hive_id", "ran_at" DESC);

-- Default 15-minute heartbeat for every existing hive. The schedule timer
-- recognises task_template.kind='hive-supervisor-heartbeat' and short-
-- circuits to runSupervisor(hiveId) instead of enqueuing a placeholder
-- task. The NOT EXISTS guard makes this idempotent — re-running the
-- migration on a hive that already has a heartbeat row is a no-op.
INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
SELECT
  h.id,
  '*/15 * * * *',
  jsonb_build_object(
    'kind', 'hive-supervisor-heartbeat',
    'assignedTo', 'hive-supervisor',
    'title', 'Hive supervisor heartbeat',
    'brief', '(populated at run time)'
  ),
  true,
  NOW() + interval '1 minute',
  'migration:0031_hive_supervisor'
FROM hives h
WHERE NOT EXISTS (
  SELECT 1 FROM schedules s
  WHERE s.hive_id = h.id
    AND s.task_template->>'kind' = 'hive-supervisor-heartbeat'
);
