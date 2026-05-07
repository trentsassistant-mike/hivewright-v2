ALTER TABLE task_workspaces
  ADD COLUMN IF NOT EXISTS effective_workspace_path text;
