import type { Sql } from "postgres";

export async function findExistingDoctorRecoveryTask(sql: Sql, failedTaskId: string) {
  const [task] = await sql`
    SELECT *
    FROM tasks
    WHERE parent_task_id = ${failedTaskId}
      AND assigned_to = 'doctor'
      AND status IN ('pending', 'active', 'running', 'claimed', 'in_review')
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return task ?? null;
}

export async function findExistingQaReplanTask(sql: Sql, failedTaskId: string) {
  const [task] = await sql`
    SELECT *
    FROM tasks
    WHERE parent_task_id = ${failedTaskId}
      AND assigned_to = 'goal-supervisor'
      AND created_by = 'dispatcher'
      AND title LIKE '[Replan] QA failed repeatedly:%'
      AND status IN ('pending', 'active', 'running', 'claimed', 'in_review')
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return task ?? null;
}
