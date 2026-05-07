import { sql } from "../_lib/db";
import { jsonError, jsonPaginated, parseSearchParams } from "../_lib/responses";
import { enforceInternalTaskHiveScope, requireApiUser, requireSystemOwner } from "../_lib/auth";
import { readIdempotencyKey, runIdempotentCreate } from "../_lib/idempotency";
import { canAccessHive } from "@/auth/users";
import {
  recordEaDirectCreateBypass,
  requireEaDirectCreateBypassReason,
} from "@/ea/native/direct-create-bypass";
import { maybeRecordEaHiveSwitch } from "@/ea/native/hive-switch-audit";
import { DefaultProjectResolutionError, resolveDefaultProjectIdForHive } from "@/projects/default-project";
import { parkTaskIfRecoveryBudgetExceeded } from "@/recovery/recovery-budget";
import {
  assertHiveCreationAllowed,
  creationPausedResponse,
  databaseCreationPaused,
  isCreationPauseDbError,
} from "@/operations/creation-pause";

type TaskRow = {
  id: string;
  hive_id: string;
  assigned_to: string;
  created_by: string;
  status: string;
  priority: number;
  title: string;
  brief: string;
  parent_task_id: string | null;
  goal_id: string | null;
  project_id: string | null;
  sprint_number: number | null;
  qa_required: boolean;
  acceptance_criteria: string | null;
  result_summary: string | null;
  retry_count: number;
  doctor_attempts: number;
  failure_reason: string | null;
  fresh_input_tokens: number | null;
  cached_input_tokens: number | null;
  cached_input_tokens_known: boolean;
  total_context_tokens: number | null;
  estimated_billable_cost_cents: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  cost_cents: number | null;
  model_used: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function mapTaskRow(r: TaskRow) {
  return {
    id: r.id,
    hiveId: r.hive_id,
    assignedTo: r.assigned_to,
    createdBy: r.created_by,
    status: r.status,
    priority: r.priority,
    title: r.title,
    brief: r.brief,
    parentTaskId: r.parent_task_id,
    goalId: r.goal_id,
    projectId: r.project_id,
    sprintNumber: r.sprint_number,
    qaRequired: r.qa_required,
    acceptanceCriteria: r.acceptance_criteria,
    resultSummary: r.result_summary,
    retryCount: r.retry_count,
    doctorAttempts: r.doctor_attempts,
    failureReason: r.failure_reason,
    freshInputTokens: r.fresh_input_tokens,
    cachedInputTokens: r.cached_input_tokens,
    cachedInputTokensKnown: r.cached_input_tokens_known,
    totalContextTokens: r.total_context_tokens,
    estimatedBillableCostCents: r.estimated_billable_cost_cents,
    tokensInput: r.tokens_input,
    tokensOutput: r.tokens_output,
    costCents: r.cost_cents,
    modelUsed: r.model_used,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const params = parseSearchParams(request.url);
    const hiveId = params.get("hiveId");
    const status = params.get("status");
    const goalId = params.get("goalId");
    const assignedTo = params.get("assignedTo");
    const projectId = params.get("projectId");
    const limit = params.getInt("limit", 50);
    const offset = params.getInt("offset", 0);

    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (hiveId) {
      if (!user.isSystemOwner) {
        const hasAccess = await canAccessHive(sql, user.id, hiveId);
        if (!hasAccess) {
          return jsonError("Forbidden: caller cannot access this hive", 403);
        }
      }
      conditions.push(`hive_id = $${paramIdx++}`);
      values.push(hiveId);
    } else if (!user.isSystemOwner) {
      conditions.push(`hive_id IN (SELECT hive_id FROM hive_memberships WHERE user_id = $${paramIdx++})`);
      values.push(user.id);
    }
    if (status) {
      conditions.push(`status = $${paramIdx++}`);
      values.push(status);
    }
    if (goalId) {
      conditions.push(`goal_id = $${paramIdx++}`);
      values.push(goalId);
    }
    if (assignedTo) {
      conditions.push(`assigned_to = $${paramIdx++}`);
      values.push(assignedTo);
    }
    if (projectId) {
      conditions.push(`project_id = $${paramIdx++}`);
      values.push(projectId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countQuery = `SELECT COUNT(*) as total FROM tasks ${whereClause}`;
    const dataQuery = `
      SELECT id, hive_id, assigned_to, created_by, status, priority, title, brief,
             parent_task_id, goal_id, project_id, sprint_number, qa_required, acceptance_criteria,
             result_summary, retry_count, doctor_attempts, failure_reason,
             fresh_input_tokens, cached_input_tokens, cached_input_tokens_known,
             total_context_tokens, estimated_billable_cost_cents,
             tokens_input, tokens_output, cost_cents, model_used,
             started_at, completed_at, created_at, updated_at
      FROM tasks ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;

    const [countRows, dataRows] = await Promise.all([
      sql.unsafe(countQuery, values as string[]),
      sql.unsafe(dataQuery, [...values, limit, offset] as string[]),
    ]);

    const total = parseInt((countRows[0] as unknown as { total: string }).total, 10);
    const data = (dataRows as unknown as TaskRow[]).map(mapTaskRow);

    return jsonPaginated(data, total, limit, offset);
  } catch {
    return jsonError("Failed to fetch tasks", 500);
  }
}

// Per-handler authorization (audit d20f7b46): task creation was previously
// open to any authenticated session, which allowed the `createdBy` attribution
// to be spoofed across roles. Until per-role JWT propagation lands, the only
// identity the system can verify is the users.is_system_owner flag, so this
// endpoint is narrowed to system owners. Non-owner agents that need to create
// tasks must acquire an owner session (or a future scoped role token) rather
// than forging a `createdBy` string.
export async function POST(request: Request) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;
  try {
    const idempotencyKey = readIdempotencyKey(request);
    if (idempotencyKey instanceof Response) return idempotencyKey;
    const body = await request.json();
    const {
      hiveId,
      assignedTo,
      title,
      brief,
      priority,
      goalId,
      projectId,
      project_id,
      sprintNumber,
      qaRequired,
      acceptanceCriteria,
      createdBy,
      sourceTaskId,
      source_task_id,
      parentTaskId,
      parent_task_id,
    } = body;
    const requestedProjectId = projectId ?? project_id ?? null;
    const requestedSourceTaskId = sourceTaskId ?? source_task_id ?? parentTaskId ?? parent_task_id ?? null;

    if (!hiveId || !assignedTo || !title || !brief) {
      return jsonError("Missing required fields: hiveId, assignedTo, title, brief", 400);
    }

    const eaBypassResult = requireEaDirectCreateBypassReason(request, body);
    if (!eaBypassResult.ok) return eaBypassResult.response;

    const taskScope = await enforceInternalTaskHiveScope(hiveId);
    if (!taskScope.ok) return taskScope.response;

    const creationPause = await assertHiveCreationAllowed(sql, hiveId);
    if (creationPause) return creationPausedResponse(creationPause);

    const resolvedProjectId = await resolveDefaultProjectIdForHive(sql, hiveId, requestedProjectId);

    const referenceCheck = await assertTaskReferencesBelongToHive(hiveId, {
      goalId: goalId ?? null,
      projectId: resolvedProjectId,
    });
    if (referenceCheck) return referenceCheck;

    // Validate delegation — if createdBy is a role (not "owner"), check delegates_to
    if (
      createdBy &&
      createdBy !== "owner" &&
      createdBy !== "ea" &&
      createdBy !== "system" &&
      createdBy !== "goal-supervisor"
    ) {
      const [creatorRole] = await sql`
        SELECT delegates_to FROM role_templates WHERE slug = ${createdBy}
      `;
      if (creatorRole) {
        const delegatesTo = typeof creatorRole.delegates_to === "string"
          ? JSON.parse(creatorRole.delegates_to || "[]")
          : (creatorRole.delegates_to || []);
        if (Array.isArray(delegatesTo) && !delegatesTo.includes(assignedTo)) {
          return jsonError(`Role '${createdBy}' cannot delegate tasks to '${assignedTo}'`, 403);
        }
      }
    }

    const sourceTaskResult = await resolveTaskSourceForCreate({
      hiveId,
      goalId: goalId ?? null,
      sourceTaskId: requestedSourceTaskId,
      title,
    });
    if ("response" in sourceTaskResult) return sourceTaskResult.response;
    const resolvedSourceTaskId = sourceTaskResult.taskId;

    return await runIdempotentCreate(sql, {
      hiveId,
      route: "/api/tasks",
      key: typeof idempotencyKey === "string" ? idempotencyKey : null,
      requestBody: body,
      create: async (tx) => {
        const rows = await tx`
          INSERT INTO tasks (
            hive_id, assigned_to, created_by, title, brief,
            priority, goal_id, project_id, sprint_number, qa_required,
            acceptance_criteria, parent_task_id
          ) VALUES (
            ${hiveId},
            ${assignedTo},
            ${createdBy ?? "system"},
            ${title},
            ${brief},
            ${priority ?? 5},
            ${goalId ?? null},
            ${resolvedProjectId},
            ${sprintNumber ?? null},
            ${qaRequired ?? false},
            ${acceptanceCriteria ?? null},
            ${resolvedSourceTaskId}
          )
          RETURNING id, hive_id, assigned_to, created_by, status, priority, title, brief,
                    parent_task_id, goal_id, project_id, sprint_number, qa_required, acceptance_criteria,
                    result_summary, retry_count, doctor_attempts, failure_reason,
                    fresh_input_tokens, cached_input_tokens, cached_input_tokens_known,
                    total_context_tokens, estimated_billable_cost_cents,
                    tokens_input, tokens_output, cost_cents, model_used,
                    started_at, completed_at, created_at, updated_at
        `;

        const task = mapTaskRow(rows[0] as unknown as TaskRow);
        await maybeRecordEaHiveSwitch(tx, request, hiveId, {
          type: "task",
          id: task.id,
        });
        await recordEaDirectCreateBypass(tx, {
          hiveId,
          bypass: eaBypassResult.bypass,
          resource: {
            type: "task",
            id: task.id,
          },
        });
        return { body: { data: task }, status: 201 };
      },
    });
  } catch (error) {
    if (isCreationPauseDbError(error)) {
      return creationPausedResponse(databaseCreationPaused());
    }
    if (error instanceof DefaultProjectResolutionError) {
      return jsonError(error.message, error.status);
    }
    return jsonError("Failed to create task", 500);
  }
}

async function resolveTaskSourceForCreate(input: {
  hiveId: string;
  goalId: string | null;
  sourceTaskId: unknown;
  title: unknown;
}): Promise<{ taskId: string | null } | { response: Response }> {
  if (input.sourceTaskId === null || input.sourceTaskId === undefined || input.sourceTaskId === "") {
    return { taskId: null };
  }
  if (typeof input.sourceTaskId !== "string") {
    return { response: jsonError("sourceTaskId must be a task id string", 400) };
  }
  const sourceTaskId = input.sourceTaskId.trim();
  if (!isUuidLike(sourceTaskId)) {
    return { response: jsonError("sourceTaskId must be a valid task id", 400) };
  }

  const [sourceTask] = await sql<{ id: string; goal_id: string | null }[]>`
    SELECT id, goal_id
    FROM tasks
    WHERE id = ${sourceTaskId}
      AND hive_id = ${input.hiveId}
  `;
  if (!sourceTask) return { response: jsonError("sourceTaskId does not belong to this hive", 404) };
  if (input.goalId && sourceTask.goal_id !== input.goalId) {
    return { response: jsonError("sourceTaskId does not belong to the supplied goal", 403) };
  }

  const budget = await parkTaskIfRecoveryBudgetExceeded(sql, sourceTaskId, {
    action: "POST /api/tasks replacement create",
    reason: String(input.title ?? "replacement task"),
    replacementTasksToCreate: 1,
  });
  if (!budget.ok) return { response: jsonError(budget.reason, 409) };

  return { taskId: sourceTaskId };
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function assertTaskReferencesBelongToHive(
  hiveId: string,
  refs: { goalId?: string | null; projectId?: string | null },
) {
  if (refs.goalId) {
    const [goal] = await sql`
      SELECT 1 FROM goals WHERE id = ${refs.goalId} AND hive_id = ${hiveId} LIMIT 1
    `;
    if (!goal) return jsonError("Forbidden: goal does not belong to hive", 403);
  }

  if (refs.projectId) {
    const [project] = await sql`
      SELECT 1 FROM projects WHERE id = ${refs.projectId} AND hive_id = ${hiveId} LIMIT 1
    `;
    if (!project) return jsonError("Forbidden: project does not belong to hive", 403);
  }

  return null;
}
