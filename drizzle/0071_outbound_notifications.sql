CREATE TABLE IF NOT EXISTS "outbound_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hive_id" uuid REFERENCES "hives"("id") ON DELETE SET NULL,
  "category" varchar(80) NOT NULL,
  "source_table" varchar(80) NOT NULL,
  "source_id" uuid NOT NULL,
  "entity_type" varchar(80) NOT NULL,
  "entity_id" uuid NOT NULL,
  "channel_id" varchar(32) NOT NULL,
  "title" text NOT NULL,
  "reason" text NOT NULL,
  "status" varchar(32) DEFAULT 'pending' NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "notified_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "outbound_notifications_source_idx"
  ON "outbound_notifications" ("category", "source_table", "source_id");

CREATE INDEX IF NOT EXISTS "outbound_notifications_status_idx"
  ON "outbound_notifications" ("status", "created_at");

ALTER TABLE "outbound_notifications"
  ADD COLUMN IF NOT EXISTS "entity_type" varchar(80);

ALTER TABLE "outbound_notifications"
  ADD COLUMN IF NOT EXISTS "entity_id" uuid;

UPDATE "outbound_notifications"
SET
  "entity_type" = COALESCE("entity_type", CASE WHEN "source_table" = 'decisions' THEN 'decision' ELSE 'goal' END),
  "entity_id" = COALESCE("entity_id", "source_id")
WHERE "entity_type" IS NULL OR "entity_id" IS NULL;

ALTER TABLE "outbound_notifications"
  ALTER COLUMN "entity_type" SET NOT NULL,
  ALTER COLUMN "entity_id" SET NOT NULL;
