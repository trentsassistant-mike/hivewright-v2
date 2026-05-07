-- Daily Current Tech Research kickoff. Idempotent backfill for existing hives;
-- new hives get the same schedule via seedDefaultSchedules().
--
-- Cadence is 08:30 in Australia/Melbourne on production HiveWright hosts. The
-- schedules table stores cron without an explicit timezone, so this migration
-- computes the first next_run_at using Australia/Melbourne as the intended
-- local schedule reference.

INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
SELECT
  h.id,
  '30 8 * * *',
  jsonb_build_object(
    'kind', 'current-tech-research-daily',
    'assignedTo', 'goal-supervisor',
    'title', 'Current tech research daily cycle',
    'brief', '(populated at run time)'
  ),
  true,
  CASE
    WHEN (now() AT TIME ZONE 'Australia/Melbourne')::time < TIME '08:30'
      THEN (date_trunc('day', now() AT TIME ZONE 'Australia/Melbourne') + interval '8 hours 30 minutes') AT TIME ZONE 'Australia/Melbourne'
    ELSE (date_trunc('day', now() AT TIME ZONE 'Australia/Melbourne') + interval '1 day' + interval '8 hours 30 minutes') AT TIME ZONE 'Australia/Melbourne'
  END,
  'migration:0061_current_tech_research_schedule'
FROM hives h
WHERE NOT EXISTS (
  SELECT 1 FROM schedules s
  WHERE s.hive_id = h.id
    AND s.task_template->>'kind' = 'current-tech-research-daily'
);
