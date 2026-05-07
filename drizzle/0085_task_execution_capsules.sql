CREATE TABLE IF NOT EXISTS "task_execution_capsules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "hive_id" uuid NOT NULL REFERENCES "hives"("id") ON DELETE CASCADE,
  "adapter_type" varchar(100) NOT NULL,
  "model" varchar(255),
  "session_id" text,
  "status" varchar(50) NOT NULL DEFAULT 'active',
  "qa_state" varchar(50) NOT NULL DEFAULT 'not_required',
  "rework_count" integer NOT NULL DEFAULT 0,
  "last_output" text,
  "last_qa_feedback" text,
  "fallback_reason" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "task_execution_capsules_task_id_unique"
  ON "task_execution_capsules" ("task_id");

CREATE INDEX IF NOT EXISTS "task_execution_capsules_status_idx"
  ON "task_execution_capsules" ("status", "qa_state", "updated_at");
