-- Voice EA: per-hive phone/voice sessions backed by the GPU voice-services
-- stack (STT/TTS) with per-session event log and owner speaker-verification
-- voiceprints. Costs and transport seconds are tracked per session so the
-- dashboard can surface voice spend alongside the rest of EA usage.
-- Idempotent — safe to re-apply via the OUT_OF_JOURNAL replay path in
-- scripts/setup-test-db.ts.

CREATE TABLE IF NOT EXISTS "voice_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hive_id" uuid NOT NULL,
  "started_at" timestamp NOT NULL DEFAULT now(),
  "ended_at" timestamp,
  "end_reason" varchar(32),
  "twilio_call_sid" varchar(64),
  "transport_seconds" integer NOT NULL DEFAULT 0,
  "llm_cost_cents" integer NOT NULL DEFAULT 0,
  "transport_cost_cents" integer NOT NULL DEFAULT 0,
  CONSTRAINT "voice_sessions_hive_id_fkey"
    FOREIGN KEY ("hive_id") REFERENCES "hives"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "voice_sessions_hive_started_at_idx"
  ON "voice_sessions" ("hive_id", "started_at");

CREATE TABLE IF NOT EXISTS "voice_session_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "at" timestamp NOT NULL DEFAULT now(),
  "kind" varchar(32) NOT NULL,
  "text" varchar(65535),
  "metadata" jsonb,
  CONSTRAINT "voice_session_events_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "voice_sessions"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "voice_session_events_session_at_idx"
  ON "voice_session_events" ("session_id", "at");

CREATE TABLE IF NOT EXISTS "owner_voiceprints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hive_id" uuid NOT NULL,
  "embedding" vector(192) NOT NULL,
  "enrolled_at" timestamp NOT NULL DEFAULT now(),
  "last_verified_at" timestamp,
  CONSTRAINT "owner_voiceprints_hive_id_fkey"
    FOREIGN KEY ("hive_id") REFERENCES "hives"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "owner_voiceprints_hive_idx"
  ON "owner_voiceprints" ("hive_id");
