-- Dashboard EA chat support. Reuses ea_threads/ea_messages and adds the
-- status fields needed by the dashboard to distinguish pending, sent, and
-- failed assistant turns.

ALTER TABLE "ea_messages"
  ADD COLUMN IF NOT EXISTS "status" varchar(32) NOT NULL DEFAULT 'sent',
  ADD COLUMN IF NOT EXISTS "error" text,
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp DEFAULT now() NOT NULL;

ALTER TABLE "ea_messages"
  DROP CONSTRAINT IF EXISTS "ea_messages_source_chk";

ALTER TABLE "ea_messages"
  ADD CONSTRAINT "ea_messages_source_chk"
  CHECK (source IN ('discord', 'voice', 'dashboard', 'system'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'ea_messages'
      AND constraint_name = 'ea_messages_status_chk'
  ) THEN
    ALTER TABLE "ea_messages"
      ADD CONSTRAINT "ea_messages_status_chk"
      CHECK (status IN ('queued', 'streaming', 'sent', 'failed'));
  END IF;
END $$;
