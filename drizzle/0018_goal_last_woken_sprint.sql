-- Formalise the `last_woken_sprint` column on goals. Previously added at
-- runtime by the dispatcher's goal-lifecycle module, which logged a PG
-- NOTICE (42701) on every wake cycle.

ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "last_woken_sprint" integer;
