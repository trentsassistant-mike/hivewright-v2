-- AI Board — the deliberative layer above the EA. Each owner question
-- spawns a board_sessions row; each member's contribution is a board_turns
-- row. Transcripts are kept so the owner can scroll back.

CREATE TABLE IF NOT EXISTS "board_sessions" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "hive_id"         uuid NOT NULL REFERENCES "hives"("id") ON DELETE CASCADE,
  "question"        text NOT NULL,
  "recommendation"  text,
  "status"          varchar(32) NOT NULL DEFAULT 'running',  -- running | done | error
  "error_text"      text,
  "created_at"      timestamp NOT NULL DEFAULT now(),
  "completed_at"    timestamp
);

CREATE INDEX IF NOT EXISTS "idx_board_sessions_hive"
  ON "board_sessions" ("hive_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "board_turns" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id"  uuid NOT NULL REFERENCES "board_sessions"("id") ON DELETE CASCADE,
  "member_slug" varchar(100) NOT NULL,
  "member_name" varchar(255) NOT NULL,
  "content"     text NOT NULL,
  "order_index" integer NOT NULL,
  "created_at"  timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_board_turns_session"
  ON "board_turns" ("session_id", "order_index");
