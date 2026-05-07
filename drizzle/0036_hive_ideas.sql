-- Ideas backlog per hive. Sprint 1 — schema + CRUD API. The daily review
-- loop (Sprint 3) populates `ai_assessment`, flips status to 'reviewed' /
-- 'promoted' / 'archived', and sets `promoted_to_goal_id` when it spawns a
-- goal via /api/work.
-- Idempotent — safe to re-apply via the OUT_OF_JOURNAL replay path in
-- scripts/setup-test-db.ts.
CREATE TABLE IF NOT EXISTS "hive_ideas" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "hive_id" uuid NOT NULL,
  "title" varchar(255) NOT NULL,
  "body" text,
  "created_by" varchar(50) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'open',
  "reviewed_at" timestamp,
  "ai_assessment" text,
  "promoted_to_goal_id" uuid,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "hive_ideas_hive_id_fkey"
    FOREIGN KEY ("hive_id") REFERENCES "hives"("id") ON DELETE CASCADE,
  CONSTRAINT "hive_ideas_promoted_to_goal_id_fkey"
    FOREIGN KEY ("promoted_to_goal_id") REFERENCES "goals"("id") ON DELETE SET NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'hive_ideas' AND constraint_name = 'hive_ideas_status_check'
  ) THEN
    ALTER TABLE "hive_ideas"
      ADD CONSTRAINT "hive_ideas_status_check"
      CHECK ("status" IN ('open', 'reviewed', 'promoted', 'archived'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "hive_ideas_hive_id_idx"
  ON "hive_ideas" ("hive_id");

CREATE INDEX IF NOT EXISTS "hive_ideas_hive_id_status_idx"
  ON "hive_ideas" ("hive_id", "status");
