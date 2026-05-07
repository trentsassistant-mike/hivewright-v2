ALTER TABLE skill_drafts
  ADD COLUMN IF NOT EXISTS target_role_slugs jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS originating_task_id uuid,
  ADD COLUMN IF NOT EXISTS originating_feedback_id uuid,
  ADD COLUMN IF NOT EXISTS source_type varchar(20) NOT NULL DEFAULT 'internal',
  ADD COLUMN IF NOT EXISTS provenance_url text,
  ADD COLUMN IF NOT EXISTS internal_source_ref text,
  ADD COLUMN IF NOT EXISTS license_notes text,
  ADD COLUMN IF NOT EXISTS security_review_status varchar(20) NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS qa_review_status varchar(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS approved_by varchar(255),
  ADD COLUMN IF NOT EXISTS approved_at timestamp,
  ADD COLUMN IF NOT EXISTS published_by varchar(255),
  ADD COLUMN IF NOT EXISTS published_at timestamp,
  ADD COLUMN IF NOT EXISTS archived_by varchar(255),
  ADD COLUMN IF NOT EXISTS archived_at timestamp,
  ADD COLUMN IF NOT EXISTS archive_reason text,
  ADD COLUMN IF NOT EXISTS adoption_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT NOW();
--> statement-breakpoint
UPDATE skill_drafts
SET source_task_id = NULL
WHERE source_task_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM tasks WHERE tasks.id = skill_drafts.source_task_id
  );
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'skill_drafts_originating_task_id_tasks_id_fk'
  ) THEN
    ALTER TABLE skill_drafts
      ADD CONSTRAINT skill_drafts_originating_task_id_tasks_id_fk
      FOREIGN KEY (originating_task_id) REFERENCES tasks(id) ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE skill_drafts
  DROP CONSTRAINT IF EXISTS skill_drafts_source_task_id_tasks_id_fk;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'skill_drafts_source_task_id_tasks_id_fk'
  ) THEN
    ALTER TABLE skill_drafts
      ADD CONSTRAINT skill_drafts_source_task_id_tasks_id_fk
      FOREIGN KEY (source_task_id) REFERENCES tasks(id) ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS skill_drafts_lifecycle_discovery_idx
  ON skill_drafts (hive_id, status, slug);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS skill_drafts_originating_feedback_idx
  ON skill_drafts (originating_feedback_id);
