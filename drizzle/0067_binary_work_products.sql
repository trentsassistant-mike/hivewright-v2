ALTER TABLE work_products
  ADD COLUMN IF NOT EXISTS artifact_kind varchar(50),
  ADD COLUMN IF NOT EXISTS file_path text,
  ADD COLUMN IF NOT EXISTS mime_type varchar(100),
  ADD COLUMN IF NOT EXISTS width integer,
  ADD COLUMN IF NOT EXISTS height integer,
  ADD COLUMN IF NOT EXISTS model_snapshot varchar(100),
  ADD COLUMN IF NOT EXISTS prompt_tokens integer,
  ADD COLUMN IF NOT EXISTS output_tokens integer,
  ADD COLUMN IF NOT EXISTS cost_cents integer,
  ADD COLUMN IF NOT EXISTS metadata jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_work_products_binary_artifacts
  ON work_products (hive_id, task_id, artifact_kind)
  WHERE artifact_kind IS NOT NULL;
