ALTER TABLE "hive_runtime_locks"
  ADD COLUMN IF NOT EXISTS "operating_state" text NOT NULL DEFAULT 'normal';

ALTER TABLE "hive_runtime_locks"
  ADD COLUMN IF NOT EXISTS "schedule_snapshot" jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE "hive_runtime_locks"
SET "operating_state" = CASE
  WHEN "creation_paused" = true THEN 'paused'
  ELSE 'normal'
END
WHERE "operating_state" IS NULL
   OR "operating_state" = 'normal';

CREATE TABLE IF NOT EXISTS "hive_runtime_lock_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "hive_id" uuid NOT NULL REFERENCES "hives"("id") ON DELETE CASCADE,
  "previous_state" text,
  "next_state" text NOT NULL,
  "creation_paused" boolean NOT NULL,
  "reason" text,
  "changed_by" text,
  "schedule_snapshot" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "hive_runtime_lock_events_hive_created_idx"
  ON "hive_runtime_lock_events" ("hive_id", "created_at" DESC);
