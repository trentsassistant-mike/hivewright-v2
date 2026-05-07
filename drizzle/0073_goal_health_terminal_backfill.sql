ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "health" varchar(50);

UPDATE "goals"
SET "health" = NULL
WHERE "status" NOT IN ('active', 'paused')
  AND "health" IS NOT NULL;
