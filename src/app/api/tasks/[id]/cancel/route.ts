import { sql } from "../../../_lib/db";
import { jsonError, jsonOk } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { canMutateHive } from "@/auth/users";
import { emitTaskEvent } from "@/dispatcher/event-emitter";

type TaskRow = {
  id: string;
  hive_id: string;
  assigned_to: string;
  created_by: string;
  status: string;
  title: string;
  parent_task_id: string | null;
  goal_id: string | null;
  model_used: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function mapTask(row: TaskRow) {
  return {
    id: row.id,
    hiveId: row.hive_id,
    assignedTo: row.assigned_to,
    createdBy: row.created_by,
    status: row.status,
    title: row.title,
    parentTaskId: row.parent_task_id,
    goalId: row.goal_id,
    modelUsed: row.model_used,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";

    const [task] = await sql<TaskRow[]>`
      SELECT
        id,
        hive_id,
        assigned_to,
        created_by,
        status,
        title,
        parent_task_id,
        goal_id,
        model_used,
        started_at,
        completed_at,
        created_at,
        updated_at
      FROM tasks
      WHERE id = ${id}
      LIMIT 1
    `;
    if (!task) return jsonError("Task not found", 404);

    if (!authz.user.isSystemOwner) {
      const canMutate = await canMutateHive(sql, authz.user.id, task.hive_id);
      if (!canMutate) return jsonError("Forbidden: caller cannot mutate this hive", 403);
    }

    if (!["pending", "active"].includes(task.status)) {
      return jsonError(`Task status ${task.status} cannot be cancelled`, 409);
    }

    const failureReason = reason.length > 0 ? `Cancelled by owner: ${reason}` : "Cancelled by owner";
    const [updated] = await sql<TaskRow[]>`
      UPDATE tasks
      SET
        status = 'cancelled',
        completed_at = NOW(),
        updated_at = NOW(),
        failure_reason = ${failureReason}
      WHERE id = ${id}
      RETURNING
        id,
        hive_id,
        assigned_to,
        created_by,
        status,
        title,
        parent_task_id,
        goal_id,
        model_used,
        started_at,
        completed_at,
        created_at,
        updated_at
    `;

    await emitTaskEvent(sql, {
      type: "task_cancelled",
      taskId: updated.id,
      title: updated.title,
      assignedTo: updated.assigned_to,
      hiveId: updated.hive_id,
    });

    return jsonOk({ cancelled: true, task: mapTask(updated) });
  } catch (err) {
    console.error("[api/tasks/:id/cancel]", err);
    return jsonError("Failed to cancel task", 500);
  }
}
