-- Daily task-quality owner feedback sampler. Idempotent backfill for
-- existing hives; new hives get the same schedule via seedDefaultSchedules().

INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
SELECT
  h.id,
  '0 10 * * *',
  jsonb_build_object(
    'kind', 'task-quality-feedback-sample',
    'assignedTo', 'initiative-engine',
    'title', 'Task quality feedback sample',
    'brief', '(populated at run time)'
  ),
  true,
  CASE
    WHEN (now() AT TIME ZONE 'UTC')::time < TIME '10:00'
      THEN (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '10 hours') AT TIME ZONE 'UTC'
    ELSE (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day' + interval '10 hours') AT TIME ZONE 'UTC'
  END,
  'migration:0056_task_quality_feedback_schedule'
FROM hives h
WHERE NOT EXISTS (
  SELECT 1 FROM schedules s
  WHERE s.hive_id = h.id
    AND s.task_template->>'kind' = 'task-quality-feedback-sample'
);
