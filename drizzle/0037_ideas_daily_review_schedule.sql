-- Ideas daily review: seed one once-daily ideas backlog review schedule
-- for every existing hive. Idempotent — safe to re-apply via the
-- OUT_OF_JOURNAL replay path in scripts/setup-test-db.ts.

INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
SELECT
  h.id,
  '0 9 * * *',
  jsonb_build_object(
    'kind', 'ideas-daily-review',
    'assignedTo', 'ideas-curator',
    'title', 'Ideas daily review',
    'brief', '(populated at run time)'
  ),
  true,
  CASE
    WHEN LOCALTIME < TIME '09:00'
      THEN date_trunc('day', now()) + interval '9 hours'
    ELSE date_trunc('day', now()) + interval '1 day' + interval '9 hours'
  END,
  'migration:0037_ideas_daily_review_schedule'
FROM hives h
WHERE NOT EXISTS (
  SELECT 1 FROM schedules s
  WHERE s.hive_id = h.id
    AND s.task_template->>'kind' = 'ideas-daily-review'
);
