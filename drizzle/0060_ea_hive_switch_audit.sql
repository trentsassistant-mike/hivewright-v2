CREATE TABLE IF NOT EXISTS "ea_hive_switch_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "from_hive_id" uuid NOT NULL REFERENCES "hives"("id") ON DELETE CASCADE,
  "to_hive_id" uuid NOT NULL REFERENCES "hives"("id") ON DELETE CASCADE,
  "ea_thread_id" uuid REFERENCES "ea_threads"("id") ON DELETE SET NULL,
  "owner_message_id" uuid REFERENCES "ea_messages"("id") ON DELETE SET NULL,
  "request_path" varchar(255) NOT NULL,
  "request_method" varchar(16) NOT NULL,
  "actor" varchar(100) DEFAULT 'ea' NOT NULL,
  "source" varchar(32) NOT NULL,
  "created_resource_type" varchar(64),
  "created_resource_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "ea_hive_switch_audit_from_hive_created_idx"
  ON "ea_hive_switch_audit" ("from_hive_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "ea_hive_switch_audit_to_hive_created_idx"
  ON "ea_hive_switch_audit" ("to_hive_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "ea_hive_switch_audit_thread_created_idx"
  ON "ea_hive_switch_audit" ("ea_thread_id", "created_at" DESC);
