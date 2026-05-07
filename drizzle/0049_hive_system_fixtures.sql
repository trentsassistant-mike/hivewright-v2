ALTER TABLE "hives"
  ADD COLUMN IF NOT EXISTS "is_system_fixture" boolean NOT NULL DEFAULT false;

UPDATE "hives"
SET "is_system_fixture" = true
WHERE "slug" = 'owner-session-smoke';
