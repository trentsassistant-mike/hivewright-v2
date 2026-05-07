-- Native Discord EA: replaces the OpenClaw-gateway-backed EA with a
-- direct discord.js connector running inside the dispatcher process.
-- Stores conversation threads + messages here instead of the
-- file-based AGENTS.md dance, so context is always fresh from DB.

CREATE TABLE IF NOT EXISTS "ea_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hive_id" uuid NOT NULL,
  "channel_id" varchar(64) NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'active',
  "created_at" timestamp DEFAULT now() NOT NULL,
  "closed_at" timestamp,
  CONSTRAINT "ea_threads_hive_id_fkey"
    FOREIGN KEY ("hive_id") REFERENCES "hives"("id") ON DELETE CASCADE
);

-- One active thread per (hive, channel). When /new runs we close the
-- current one and open a fresh row. Partial unique so historical closed
-- rows don't block future active threads.
CREATE UNIQUE INDEX IF NOT EXISTS "ea_threads_active_per_channel"
  ON "ea_threads" ("hive_id", "channel_id")
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS "ea_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "thread_id" uuid NOT NULL,
  "role" varchar(32) NOT NULL,
  "content" text NOT NULL,
  "discord_message_id" varchar(64),
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ea_messages_thread_id_fkey"
    FOREIGN KEY ("thread_id") REFERENCES "ea_threads"("id") ON DELETE CASCADE,
  CONSTRAINT "ea_messages_role_check"
    CHECK (role IN ('owner', 'assistant', 'system'))
);

CREATE INDEX IF NOT EXISTS "ea_messages_thread_id_created_at_idx"
  ON "ea_messages" ("thread_id", "created_at" ASC);
