import { sql } from "../_lib/db";
import { jsonError, jsonOk, jsonPaginated, parseSearchParams } from "../_lib/responses";
import { enforceInternalTaskHiveScope, requireApiUser } from "../_lib/auth";
import { canAccessHive } from "@/auth/users";
import { maybeRecordEaHiveSwitch } from "@/ea/native/hive-switch-audit";
import { AGENT_AUDIT_EVENTS } from "@/audit/agent-events";
import { recordDecisionAuditEvent } from "./_audit";
import { parkTaskIfRecoveryBudgetExceeded } from "@/recovery/recovery-budget";
import {
  assertHiveCreationAllowed,
  creationPausedResponse,
  databaseCreationPaused,
  isCreationPauseDbError,
} from "@/operations/creation-pause";

type DecisionRow = {
  id: string;
  hive_id: string;
  goal_id: string | null;
  task_id: string | null;
  title: string;
  context: string;
  recommendation: string | null;
  options: unknown;
  priority: string;
  status: string;
  kind: string;
  owner_response: string | null;
  selected_option_key: string | null;
  selected_option_label: string | null;
  ea_attempts: number | null;
  ea_reasoning: string | null;
  ea_decided_at: Date | null;
  created_at: Date;
  resolved_at: Date | null;
  task_title: string | null;
  task_role: string | null;
  task_completed_at: Date | null;
  is_qa_fixture: boolean;
};

function mapDecisionRow(r: DecisionRow) {
  return {
    id: r.id,
    hiveId: r.hive_id,
    goalId: r.goal_id,
    taskId: r.task_id,
    title: r.title,
    context: r.context,
    recommendation: r.recommendation,
    options: r.options,
    priority: r.priority,
    status: r.status,
    kind: r.kind,
    ownerResponse: r.owner_response,
    selectedOptionKey: r.selected_option_key,
    selectedOptionLabel: r.selected_option_label,
    eaAttempts: r.ea_attempts ?? 0,
    eaReasoning: r.ea_reasoning,
    eaDecidedAt: r.ea_decided_at,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    isQaFixture: r.is_qa_fixture,
    task: r.task_id
      ? {
          id: r.task_id,
          title: r.task_title ?? r.title,
          role: r.task_role,
          completedAt: r.task_completed_at,
        }
      : null,
  };
}

const PRIORITY_ORDER = `
  CASE d.priority
    WHEN 'urgent' THEN 1
    WHEN 'high' THEN 2
    WHEN 'normal' THEN 3
    WHEN 'low' THEN 4
    ELSE 5
  END
`;

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;

  try {
    const params = parseSearchParams(request.url);
    const hiveId = params.get("hiveId");
    const status = params.get("status") ?? "pending";
    // Default to 'decision' so the legacy Decisions page only sees owner
    // judgement calls. Callers can pass kind=system_error for the System
    // Health feed, or kind=all to get everything unfiltered.
    const includeKinds = params.get("includeKinds")
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const kind = params.get("kind") ?? (includeKinds && includeKinds.length > 0 ? null : "decision");
    const limit = params.getInt("limit", 50);
    const offset = params.getInt("offset", 0);
    const qaFixtures = params.get("qaFixtures") === "true";
    const qaRunId = params.get("qaRunId");

    if (!hiveId) return jsonError("hiveId is required", 400);
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, hiveId);
      if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
    }

    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (hiveId) {
      conditions.push(`d.hive_id = $${paramIdx++}`);
      values.push(hiveId);
    }
    if (status) {
      conditions.push(`d.status = $${paramIdx++}`);
      values.push(status);
    }
    if (kind && kind !== "all") {
      conditions.push(`d.kind = $${paramIdx++}`);
      values.push(kind);
    } else if (includeKinds && includeKinds.length > 0) {
      conditions.push(`d.kind = ANY($${paramIdx++}::text[])`);
      values.push(includeKinds);
    }
    if (qaFixtures) {
      if (process.env.HIVEWRIGHT_QA_SMOKE !== "true") {
        return jsonError("QA fixtures are only available when HIVEWRIGHT_QA_SMOKE=true", 403);
      }
      conditions.push("d.is_qa_fixture = true");
      if (qaRunId) {
        conditions.push(`d.options #>> '{qa,runId}' = $${paramIdx++}`);
        values.push(qaRunId);
      }
    } else {
      conditions.push("d.is_qa_fixture = false");
    }
    const requestsQualityFeedback = kind === "task_quality_feedback" ||
      includeKinds?.includes("task_quality_feedback");
    if (requestsQualityFeedback && params.get("includeAiPeerQualityFeedback") !== "true") {
      conditions.push("COALESCE(d.options #>> '{lane}', 'owner') = 'owner'");
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countQuery = `SELECT COUNT(*) as total FROM decisions d ${whereClause}`;
    const dataQuery = `
      SELECT d.id, d.hive_id, d.goal_id, d.task_id, d.title, d.context, d.recommendation, d.options,
             d.priority, d.status, d.kind, d.owner_response, d.selected_option_key, d.selected_option_label,
             d.ea_attempts, d.ea_reasoning, d.ea_decided_at,
             d.created_at, d.resolved_at, d.is_qa_fixture,
             t.title AS task_title, t.assigned_to AS task_role, t.completed_at AS task_completed_at
      FROM decisions d
      LEFT JOIN tasks t ON t.id = d.task_id AND t.hive_id = d.hive_id
      ${whereClause}
      ORDER BY ${PRIORITY_ORDER}, d.created_at DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;

    const [countRows, dataRows] = await Promise.all([
      sql.unsafe(countQuery, values as string[]),
      sql.unsafe(dataQuery, [...values, limit, offset] as string[]),
    ]);

    const total = parseInt((countRows[0] as unknown as { total: string }).total, 10);
    const data = (dataRows as unknown as DecisionRow[]).map(mapDecisionRow);

    return jsonPaginated(data, total, limit, offset);
  } catch {
    return jsonError("Failed to fetch decisions", 500);
  }
}

// Per-handler authorization (audit 2026-04-22 task-area pass).
// Decision creation blocks a task by flipping `tasks.status='blocked'`.
// Previously any authenticated session could pick an arbitrary hiveId and
// taskId and forcibly block a task in an unrelated hive. Minimum hardening:
//   1. `requireApiUser()` resolves the caller identity.
//   2. `canAccessHive()` gates the supplied hiveId — system owners bypass.
//   3. The referenced task must belong to that hive before the decision row
//      is inserted and the task is transitioned to 'blocked'.
export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const body = await request.json();
    const { hiveId, taskId, question, context, options, goalId, priority } = body;

    if (!hiveId || !taskId || !question || !context || options === undefined) {
      return jsonError("Missing required fields: hiveId, taskId, question, context, options", 400);
    }

    const taskScope = await enforceInternalTaskHiveScope(hiveId);
    if (!taskScope.ok) return taskScope.response;

    const creationPause = await assertHiveCreationAllowed(sql, hiveId);
    if (creationPause) return creationPausedResponse(creationPause);

    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, hiveId);
      if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
    }

    const [taskRow] = await sql<{ hiveId: string }[]>`
      SELECT hive_id AS "hiveId" FROM tasks WHERE id = ${taskId}
    `;
    if (!taskRow) return jsonError("Task not found", 404);
    if (taskRow.hiveId !== hiveId) {
      return jsonError("Task does not belong to the supplied hive", 403);
    }

    const budget = await parkTaskIfRecoveryBudgetExceeded(sql, taskId, {
      action: "POST /api/decisions recovery decision create",
      reason: String(question),
      recoveryDecisionsToCreate: 1,
    });
    if (!budget.ok) return jsonError(budget.reason, 409);

    // Route through EA-first — see feedback memory "Decisions go to EA
    // first, owner only when genuinely needed". The EA pipeline fires
    // the owner-facing notification with rewritten plain-English context
    // if (and only if) it escalates.
    const [row] = await sql`
      INSERT INTO decisions (
        hive_id, task_id, goal_id,
        title, context, options,
        priority, status
      ) VALUES (
        ${hiveId}, ${taskId}, ${goalId ?? null},
        ${question}, ${context}, ${sql.json(options)},
        ${priority ?? "normal"}, 'ea_review'
      )
      RETURNING id, hive_id, goal_id, task_id, title, context, recommendation,
                options, priority, status, kind, owner_response,
                selected_option_key, selected_option_label,
                ea_attempts, ea_reasoning, ea_decided_at,
                created_at, resolved_at
    `;

    await sql`
      UPDATE tasks SET status = 'blocked', updated_at = NOW() WHERE id = ${taskId}
    `;

    const decision = mapDecisionRow(row as unknown as DecisionRow);
    await recordDecisionAuditEvent({
      sql,
      request,
      user,
      eventType: AGENT_AUDIT_EVENTS.decisionCreated,
      decision: row as unknown as DecisionRow,
      metadata: {
        source: "decisions_post",
        taskBlocked: true,
        questionProvided: true,
        contextProvided: true,
      },
    });
    await maybeRecordEaHiveSwitch(sql, request, hiveId, {
      type: "decision",
      id: decision.id,
    });
    return jsonOk(decision, 201);
  } catch (error) {
    if (isCreationPauseDbError(error)) {
      return creationPausedResponse(databaseCreationPaused());
    }
    return jsonError("Failed to create decision", 500);
  }
}
