CREATE TABLE IF NOT EXISTS "agent_audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_type" varchar(120) NOT NULL,
  "actor_type" varchar(32) DEFAULT 'system' NOT NULL,
  "actor_id" varchar(255),
  "actor_label" varchar(255),
  "hive_id" uuid REFERENCES "hives"("id") ON DELETE SET NULL,
  "goal_id" uuid REFERENCES "goals"("id") ON DELETE SET NULL,
  "task_id" uuid REFERENCES "tasks"("id") ON DELETE SET NULL,
  "agent_id" varchar(255),
  "target_type" varchar(80) NOT NULL,
  "target_id" varchar(255),
  "outcome" varchar(32) NOT NULL,
  "request_id" varchar(255),
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "agent_audit_events_hive_created_idx"
  ON "agent_audit_events" ("hive_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "agent_audit_events_task_created_idx"
  ON "agent_audit_events" ("task_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "agent_audit_events_event_type_created_idx"
  ON "agent_audit_events" ("event_type", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "agent_audit_events_target_created_idx"
  ON "agent_audit_events" ("target_type", "target_id", "created_at" DESC);
