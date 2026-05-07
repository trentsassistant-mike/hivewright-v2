-- Daily world scan: backfill next_run_at for schedules seeded before the
-- seeder populated it. Idempotent: rows that already have next_run_at are
-- left untouched, and no schedules are inserted.

UPDATE schedules
SET next_run_at = (CASE
  WHEN (now() AT TIME ZONE 'UTC')::time < TIME '07:00'
    THEN date_trunc('day', now() AT TIME ZONE 'UTC') + interval '7 hours'
  ELSE date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day' + interval '7 hours'
END AT TIME ZONE 'UTC')::timestamp
WHERE task_template ->> 'title' = 'Daily world scan'
  AND next_run_at IS NULL;
