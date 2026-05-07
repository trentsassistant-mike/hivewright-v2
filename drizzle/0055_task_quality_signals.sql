CREATE TABLE IF NOT EXISTS "task_quality_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL,
  "hive_id" uuid NOT NULL,
  "signal_type" varchar(32) NOT NULL,
  "source" varchar(64) NOT NULL,
  "evidence" text NOT NULL,
  "confidence" real NOT NULL DEFAULT 0.5,
  "owner_message_id" uuid,
  "rating" real,
  "comment" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "task_quality_signals_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE,
  CONSTRAINT "task_quality_signals_hive_id_fkey"
    FOREIGN KEY ("hive_id") REFERENCES "hives"("id") ON DELETE CASCADE,
  CONSTRAINT "task_quality_signals_owner_message_id_fkey"
    FOREIGN KEY ("owner_message_id") REFERENCES "ea_messages"("id") ON DELETE SET NULL,
  CONSTRAINT "task_quality_signals_type_chk"
    CHECK ("signal_type" IN ('positive', 'negative', 'neutral')),
  CONSTRAINT "task_quality_signals_source_chk"
    CHECK ("source" IN ('implicit_ea', 'explicit_owner_feedback')),
  CONSTRAINT "task_quality_signals_confidence_chk"
    CHECK ("confidence" >= 0 AND "confidence" <= 1)
);

CREATE INDEX IF NOT EXISTS "task_quality_signals_hive_created_idx"
  ON "task_quality_signals" ("hive_id", "created_at");

CREATE INDEX IF NOT EXISTS "task_quality_signals_task_created_idx"
  ON "task_quality_signals" ("task_id", "created_at");

CREATE INDEX IF NOT EXISTS "task_quality_signals_source_idx"
  ON "task_quality_signals" ("source", "created_at");
