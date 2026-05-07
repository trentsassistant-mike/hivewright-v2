-- Initiative evaluation: seed one hourly dormant-goal evaluation schedule
-- for every existing hive. Idempotent — safe to re-apply via the
-- OUT_OF_JOURNAL replay path in scripts/setup-test-db.ts.

INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
SELECT
  h.id,
  '0 * * * *',
  jsonb_build_object(
    'kind', 'initiative-evaluation',
    'assignedTo', 'initiative-engine',
    'title', 'Initiative evaluation',
    'brief', '(populated at run time)'
  ),
  true,
  CASE
    WHEN date_trunc('hour', now()) = now()
      THEN now() + interval '1 hour'
    ELSE date_trunc('hour', now()) + interval '1 hour'
  END,
  'migration:0043_initiative_evaluation_schedule'
FROM hives h
WHERE NOT EXISTS (
  SELECT 1 FROM schedules s
  WHERE s.hive_id = h.id
    AND s.task_template->>'kind' = 'initiative-evaluation'
);
