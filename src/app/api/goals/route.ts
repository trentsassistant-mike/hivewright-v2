import { sql } from "../_lib/db";
import { jsonError, jsonPaginated, parseSearchParams } from "../_lib/responses";
import { enforceInternalTaskHiveScope, requireApiUser } from "../_lib/auth";
import { readIdempotencyKey, runIdempotentCreate } from "../_lib/idempotency";
import { canAccessHive } from "@/auth/users";
import {
  recordEaDirectCreateBypass,
  requireEaDirectCreateBypassReason,
} from "@/ea/native/direct-create-bypass";
import { maybeRecordEaHiveSwitch } from "@/ea/native/hive-switch-audit";
import { DefaultProjectResolutionError, resolveDefaultProjectIdForHive } from "@/projects/default-project";
import {
  assertHiveCreationAllowed,
  creationPausedResponse,
  databaseCreationPaused,
  isCreationPauseDbError,
} from "@/operations/creation-pause";

type GoalRow = {
  id: string;
  hive_id: string;
  project_id: string | null;
  parent_id: string | null;
  title: string;
  description: string | null;
  status: string;
  budget_cents: number | null;
  spent_cents: number;
  session_id: string | null;
  outcome_classification: string | null;
  outcome_classification_rationale: string | null;
  outcome_process_references: unknown;
  outcome_classified_at: Date | null;
  outcome_classified_by: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
  total_tasks?: string;
  completed_tasks?: string;
};

type GoalCondition = {
  count: string;
  data: string;
};

function mapGoalRow(r: GoalRow) {
  return {
    id: r.id,
    hiveId: r.hive_id,
    projectId: r.project_id,
    parentId: r.parent_id,
    title: r.title,
    description: r.description,
    status: r.status,
    budgetCents: r.budget_cents,
    spentCents: r.spent_cents,
    sessionId: r.session_id,
    outcomeClassification: r.outcome_classification,
    outcomeClassificationRationale: r.outcome_classification_rationale,
    outcomeProcessReferences: r.outcome_process_references,
    outcomeClassifiedAt: r.outcome_classified_at,
    outcomeClassifiedBy: r.outcome_classified_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
    totalTasks: parseInt(r.total_tasks ?? "0", 10),
    completedTasks: parseInt(r.completed_tasks ?? "0", 10),
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
    const limit = params.getInt("limit", 50);
    const offset = params.getInt("offset", 0);

    const conditions: GoalCondition[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (hiveId) {
      if (!user.isSystemOwner) {
        const hasAccess = await canAccessHive(sql, user.id, hiveId);
        if (!hasAccess) {
          return jsonError("Forbidden: caller cannot access this hive", 403);
        }
      }
      conditions.push({ count: `hive_id = $${paramIdx}`, data: `g.hive_id = $${paramIdx}` });
      values.push(hiveId);
      paramIdx++;
    } else if (!user.isSystemOwner) {
      conditions.push({
        count: `hive_id IN (SELECT hive_id FROM hive_memberships WHERE user_id = $${paramIdx})`,
        data: `g.hive_id IN (SELECT hive_id FROM hive_memberships WHERE user_id = $${paramIdx})`,
      });
      values.push(user.id);
      paramIdx++;
    }
    if (status) {
      conditions.push({ count: `status = $${paramIdx}`, data: `g.status = $${paramIdx}` });
      values.push(status);
      paramIdx++;
    }
    const includeArchived = params.get("includeArchived") === "1";
    if (!includeArchived) {
      conditions.push({ count: `archived_at IS NULL`, data: `g.archived_at IS NULL` });
    }

    const countWhereClause = conditions.length > 0
      ? `WHERE ${conditions.map((condition) => condition.count).join(" AND ")}`
      : "";
    const dataWhereClause = conditions.length > 0
      ? `WHERE ${conditions.map((condition) => condition.data).join(" AND ")}`
      : "";

    const countQuery = `SELECT COUNT(*) as total FROM goals ${countWhereClause}`;
    const dataQuery = `
      SELECT g.id, g.hive_id, g.parent_id, g.title, g.description, g.status,
             g.project_id, g.budget_cents, g.spent_cents, g.session_id, g.created_at, g.updated_at,
             g.archived_at, g.outcome_classification, g.outcome_classification_rationale,
             g.outcome_process_references, g.outcome_classified_at, g.outcome_classified_by,
             COUNT(t.id) AS total_tasks,
             COUNT(t.id) FILTER (WHERE t.status = 'completed') AS completed_tasks
      FROM goals g
      LEFT JOIN tasks t ON t.goal_id = g.id
      ${dataWhereClause}
      GROUP BY g.id
      ORDER BY g.created_at DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;

    const [countRows, dataRows] = await Promise.all([
      sql.unsafe(countQuery, values as string[]),
      sql.unsafe(dataQuery, [...values, limit, offset] as string[]),
    ]);

    const total = parseInt((countRows[0] as unknown as { total: string }).total, 10);
    const data = (dataRows as unknown as GoalRow[]).map(mapGoalRow);

    return jsonPaginated(data, total, limit, offset);
  } catch {
    return jsonError("Failed to fetch goals", 500);
  }
}

// Per-handler authorization (audit 2026-04-22 core-goal pass).
// Goal creation previously only checked session presence, letting any
// authenticated caller insert a goal into any hive. Minimum hardening:
//   1. Resolve caller identity via `requireApiUser()`.
//   2. Enforce `canAccessHive()` on the supplied hiveId before INSERT.
// Role-slug attribution for non-owner supervisor-originated top-level goals
// remains blocked until role propagation lands in the JWT — see the audit at
// `docs/security/2026-04-22-goal-task-mutation-auth-seams.md`.
export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const idempotencyKey = readIdempotencyKey(request);
    if (idempotencyKey instanceof Response) return idempotencyKey;
    const body = await request.json();
    const { hiveId, title, description, parentId, budgetCents, projectId, project_id } = body;
    const requestedProjectId = projectId ?? project_id ?? null;

    if (!hiveId || !title) {
      return jsonError("Missing required fields: hiveId, title", 400);
    }

    const eaBypassResult = requireEaDirectCreateBypassReason(request, body);
    if (!eaBypassResult.ok) return eaBypassResult.response;

    const taskScope = await enforceInternalTaskHiveScope(hiveId);
    if (!taskScope.ok) return taskScope.response;

    const creationPause = await assertHiveCreationAllowed(sql, hiveId);
    if (creationPause) return creationPausedResponse(creationPause);

    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this hive", 403);
      }
    }

    if (parentId) {
      const [parentGoal] = await sql`
        SELECT 1 FROM goals WHERE id = ${parentId} AND hive_id = ${hiveId} LIMIT 1
      `;
      if (!parentGoal) return jsonError("Forbidden: parent goal does not belong to hive", 403);
    }

    const resolvedProjectId = await resolveDefaultProjectIdForHive(sql, hiveId, requestedProjectId);
    if (resolvedProjectId) {
      const [project] = await sql`
        SELECT 1 FROM projects WHERE id = ${resolvedProjectId} AND hive_id = ${hiveId} LIMIT 1
      `;
      if (!project) return jsonError("Forbidden: project does not belong to hive", 403);
    }

    return await runIdempotentCreate(sql, {
      hiveId,
      route: "/api/goals",
      key: typeof idempotencyKey === "string" ? idempotencyKey : null,
      requestBody: body,
      create: async (tx) => {
        const rows = await tx`
          INSERT INTO goals (hive_id, title, description, parent_id, budget_cents, project_id)
          VALUES (
            ${hiveId},
            ${title},
            ${description ?? null},
            ${parentId ?? null},
            ${budgetCents ?? null},
            ${resolvedProjectId}
          )
          RETURNING id, hive_id, project_id, parent_id, title, description, status,
                    budget_cents, spent_cents, session_id,
                    outcome_classification, outcome_classification_rationale,
                    outcome_process_references, outcome_classified_at, outcome_classified_by,
                    created_at, updated_at, archived_at
        `;

        const goal = rows[0] as unknown as GoalRow;
        const data = mapGoalRow(goal);

        // Notify the dispatcher immediately so it starts the supervisor without
        // waiting for the 15-minute sprintCheckTimer fallback. The actual
        // owner-facing notification (Discord/Slack/etc.) is fired by the
        // dispatcher once it picks the goal up — see runGoalLifecycleCheck.
        try {
          await tx`SELECT pg_notify('new_goal', ${goal.id})`;
        } catch { /* non-fatal — dispatcher will still pick it up via timer */ }

        await maybeRecordEaHiveSwitch(tx, request, hiveId, {
          type: "goal",
          id: data.id,
        });
        await recordEaDirectCreateBypass(tx, {
          hiveId,
          bypass: eaBypassResult.bypass,
          resource: {
            type: "goal",
            id: data.id,
          },
        });
        return { body: { data }, status: 201 };
      },
    });
  } catch (error) {
    if (isCreationPauseDbError(error)) {
      return creationPausedResponse(databaseCreationPaused());
    }
    if (error instanceof DefaultProjectResolutionError) {
      return jsonError(error.message, error.status);
    }
    return jsonError("Failed to create goal", 500);
  }
}
