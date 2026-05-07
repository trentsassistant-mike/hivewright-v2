-- Structured target rows for each hive. Targets give every agent spawn
-- awareness of the hive's concrete goals (title, target value, deadline).
-- Idempotent — safe to re-apply via the OUT_OF_JOURNAL replay path.
CREATE TABLE IF NOT EXISTS "hive_targets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hive_id" uuid NOT NULL,
  "title" varchar(255) NOT NULL,
  "target_value" varchar(255),
  "deadline" date,
  "notes" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "hive_targets_hive_id_fkey"
    FOREIGN KEY ("hive_id") REFERENCES "hives"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "hive_targets_hive_id_idx"
  ON "hive_targets" ("hive_id");
