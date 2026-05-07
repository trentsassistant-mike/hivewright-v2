CREATE TABLE IF NOT EXISTS task_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  base_workspace_path text,
  worktree_path text,
  branch_name varchar(255),
  isolation_status varchar(50) NOT NULL,
  isolation_active boolean NOT NULL DEFAULT false,
  reused boolean NOT NULL DEFAULT false,
  failure_reason text,
  skipped_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reused_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS task_workspaces_task_id_unique
  ON task_workspaces(task_id);
