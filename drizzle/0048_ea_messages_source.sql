-- Tag EA messages with their transport source (discord vs voice) and
-- optionally link back to the voice_sessions row they belong to. Allows
-- the dashboard and EA thread renderer to distinguish voice turns from
-- typed Discord turns without a cross-table join every render.
-- Idempotent — safe to re-apply via the OUT_OF_JOURNAL replay path in
-- scripts/setup-test-db.ts.

ALTER TABLE "ea_messages"
  ADD COLUMN IF NOT EXISTS "source" varchar(16) NOT NULL DEFAULT 'discord',
  ADD COLUMN IF NOT EXISTS "voice_session_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'ea_messages'
      AND constraint_name = 'ea_messages_source_chk'
  ) THEN
    ALTER TABLE "ea_messages"
      ADD CONSTRAINT "ea_messages_source_chk"
      CHECK (source IN ('discord', 'voice'));
  END IF;
END $$;
