ALTER TABLE "task_attachments"
  ADD COLUMN IF NOT EXISTS "idea_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'task_attachments'
      AND constraint_name = 'task_attachments_idea_id_hive_ideas_id_fk'
  ) THEN
    ALTER TABLE "task_attachments"
      ADD CONSTRAINT "task_attachments_idea_id_hive_ideas_id_fk"
      FOREIGN KEY ("idea_id") REFERENCES "hive_ideas"("id") ON DELETE cascade;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_task_attachments_idea"
  ON "task_attachments" ("idea_id");

ALTER TABLE "task_attachments"
  DROP CONSTRAINT IF EXISTS "task_attachments_parent_check";

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'task_attachments'
      AND constraint_name = 'task_attachments_parent_check'
  ) THEN
    ALTER TABLE "task_attachments"
      ADD CONSTRAINT "task_attachments_parent_check"
      CHECK (num_nonnulls("task_id", "goal_id", "idea_id") = 1);
  END IF;
END $$;
