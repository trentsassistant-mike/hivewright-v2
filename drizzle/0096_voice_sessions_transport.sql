-- Voice EA Phase A (2026-05-07): track which carrier delivered each call's
-- audio. Existing rows are backfilled to 'twilio' (the only carrier before
-- this migration); new rows default to 'direct-ws' (PCM over WebSocket
-- straight from the PWA to the dispatcher, no Twilio involvement).
ALTER TABLE "voice_sessions"
  ADD COLUMN IF NOT EXISTS "transport" varchar(32);

UPDATE "voice_sessions"
SET "transport" = 'twilio'
WHERE "transport" IS NULL;

ALTER TABLE "voice_sessions"
  ALTER COLUMN "transport" SET NOT NULL;

ALTER TABLE "voice_sessions"
  ALTER COLUMN "transport" SET DEFAULT 'direct-ws';
