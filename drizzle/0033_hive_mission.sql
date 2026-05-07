-- Add a first-class mission statement to each hive. Every agent spawn
-- (EA, goal supervisor, executor) will be able to read the hive's purpose
-- from this column. Idempotent.
ALTER TABLE "hives"
  ADD COLUMN IF NOT EXISTS "mission" text;
