ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS adapter_used varchar(100);

CREATE INDEX IF NOT EXISTS tasks_adapter_model_used_idx
  ON tasks (adapter_used, model_used)
  WHERE model_used IS NOT NULL;
