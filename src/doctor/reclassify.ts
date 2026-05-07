import type { Sql } from "postgres";
import { runClassifier } from "@/work-intake/runner";

/**
 * Doctor's `reclassify` action. Re-runs the classifier against the failed task's brief,
 * passing the failure context as extra signal. If the classifier picks a different
 * executor role, reassign; otherwise convert the task to a goal (the default-to-goal rule).
 */
export async function applyReclassify(
  sql: Sql,
  taskId: string,
  failureContext: string,
): Promise<void> {
  const [task] = await sql<{
    id: string; hive_id: string; assigned_to: string; brief: string;
  }[]>`
    SELECT id, hive_id, assigned_to, brief FROM tasks WHERE id = ${taskId}
  `;
  if (!task) return;

  const augmentedInput = [
    task.brief,
    "",
    "---",
    `Previous attempt failed with: ${failureContext}`,
    "Consider a different executor role, or whether this work needs decomposition into a goal.",
  ].join("\n");

  const outcome = await runClassifier(sql, augmentedInput);

  if (outcome.result?.type === "task" && outcome.result.role !== task.assigned_to) {
    const [newCls] = await sql<{ id: string }[]>`
      INSERT INTO classifications (
        task_id, type, assigned_role, confidence, reasoning, provider, model, was_fallback
      ) VALUES (
        ${taskId}, 'task', ${outcome.result.role}, ${outcome.result.confidence},
        ${outcome.result.reasoning}, ${outcome.providerUsed}, ${outcome.modelUsed},
        ${outcome.usedFallback}
      ) RETURNING id
    `;
    await sql`
      UPDATE classifications
      SET superseded_by = ${newCls.id}
      WHERE task_id = ${taskId} AND id != ${newCls.id} AND superseded_by IS NULL
    `;
    await sql`
      UPDATE tasks
      SET status = 'pending', assigned_to = ${outcome.result.role},
          doctor_attempts = doctor_attempts + 1, retry_count = 0,
          retry_after = NULL, updated_at = NOW()
      WHERE id = ${taskId}
    `;
    return;
  }

  // Classifier returned null OR same role OR type=goal → default to converting to goal.
  await applyConvertToGoal(sql, taskId);
}

export async function applyConvertToGoal(sql: Sql, taskId: string): Promise<void> {
  const [task] = await sql<{
    id: string; hive_id: string; project_id: string | null; title: string; brief: string;
  }[]>`
    SELECT id, hive_id, project_id, title, brief FROM tasks WHERE id = ${taskId}
  `;
  if (!task) return;

  const [goal] = await sql<{ id: string }[]>`
    INSERT INTO goals (hive_id, title, description, project_id)
    VALUES (
      ${task.hive_id},
      ${task.title},
      ${task.brief + "\n\n---\n*Converted from task by the doctor; classifier could not find a better executor role.*"},
      ${task.project_id}
    )
    RETURNING id
  `;

  await sql`
    INSERT INTO classifications (
      task_id, goal_id, type, confidence, reasoning, provider, model, was_fallback
    ) VALUES (
      NULL, ${goal.id}, 'goal', 0.00,
      ${"Converted from task by doctor's convert-to-goal action."},
      'default-goal-fallback', NULL, false
    )
  `;

  await sql`
    UPDATE task_attachments SET task_id = NULL, goal_id = ${goal.id}
    WHERE task_id = ${taskId}
  `;

  await sql`
    UPDATE tasks
    SET status = 'cancelled',
        result_summary = ${`Converted to goal: ${goal.id}`},
        doctor_attempts = doctor_attempts + 1,
        updated_at = NOW()
    WHERE id = ${taskId}
  `;
}
