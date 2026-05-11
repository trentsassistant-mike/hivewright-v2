import { sql } from "../../../_lib/db";
import { jsonOk, jsonError } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { completeGoal, parseGoalCompletionStatus } from "@/goals/completion";

interface CompleteGoalBody {
  summary?: unknown;
  evidenceTaskIds?: unknown;
  evidenceWorkProductIds?: unknown;
  createdBy?: unknown;
  completionStatus?: unknown;
  completion_status?: unknown;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// Per-handler authorization (audit d20f7b46): the supervisor session that
// owns the goal (goals.session_id, a workspace path assigned by the
// dispatcher) is the only principal allowed to mark the goal achieved.
// System owners can override for manual completion via the dashboard.
// Supervisors assert their session by sending `X-Supervisor-Session` with
// the workspace path they were launched in; a mismatch against the stored
// goals.session_id is 403. This is stricter than session presence but does
// not yet require role propagation on the JWT.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  let goalId: string | undefined;
  try {
    const { id } = await params;
    goalId = id;

    let body: CompleteGoalBody;
    try {
      body = (await request.json()) as CompleteGoalBody;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const summary = typeof body.summary === "string" ? body.summary.trim() : "";
    if (summary.length === 0) {
      return jsonError("'summary' is required and must be a non-empty string", 400);
    }

    if (body.evidenceTaskIds !== undefined && !isStringArray(body.evidenceTaskIds)) {
      return jsonError("'evidenceTaskIds' must be an array of strings", 400);
    }
    if (body.evidenceWorkProductIds !== undefined && !isStringArray(body.evidenceWorkProductIds)) {
      return jsonError("'evidenceWorkProductIds' must be an array of strings", 400);
    }
    if (body.createdBy !== undefined) {
      if (typeof body.createdBy !== "string" || body.createdBy.trim().length === 0) {
        return jsonError("'createdBy' must be a non-empty string when provided", 400);
      }
    }

    const completionStatusInput = body.completionStatus ?? body.completion_status;
    const completionStatus = parseGoalCompletionStatus(completionStatusInput);
    if (completionStatusInput !== undefined && !completionStatus) {
      return jsonError("'completionStatus' must be one of achieved, execution_ready, blocked_on_owner_channel", 400);
    }

    const [goal] = await sql`
      SELECT id, status, session_id FROM goals WHERE id = ${id}
    `;
    if (!goal) {
      return jsonError("Goal not found", 404);
    }

    if (!authz.user.isSystemOwner) {
      const callerSession = request.headers.get("x-supervisor-session")?.trim() ?? "";
      if (!callerSession || callerSession !== goal.session_id) {
        return jsonError(
          "Forbidden: caller is not the supervisor session for this goal",
          403,
        );
      }
    }

    // Cancelled, paused, and any other non-completable terminal/transitional
    // states reject with 409 Conflict. A stale supervisor that hasn't received
    // an out-of-band cancellation should not be able to resurrect the goal as
    // achieved. Only 'active' goals proceed to completion; 'achieved' goals
    // hit the idempotent branch below.
    const finalStatuses = ["achieved", "execution_ready", "blocked_on_owner_channel"];
    if (goal.status !== "active" && !finalStatuses.includes(goal.status as string)) {
      return jsonError(
        `Goal cannot be completed: current status is '${goal.status}'`,
        409,
      );
    }

    // Idempotency: already-achieved goals return current state without
    // re-running completeGoal (avoids double memory writes + double notifications).
    if (finalStatuses.includes(goal.status as string)) {
      const [latestCompletion] = await sql`
        SELECT id, summary, evidence, created_by, created_at
        FROM goal_completions
        WHERE goal_id = ${id}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      return jsonOk({
        goalId: id,
        status: goal.status,
        idempotent: true,
        latestCompletion: latestCompletion ?? null,
      });
    }

    const completionResult = await completeGoal(sql, id, summary, {
      createdBy: typeof body.createdBy === "string" ? body.createdBy : "goal-supervisor",
      evidenceTaskIds: isStringArray(body.evidenceTaskIds) ? body.evidenceTaskIds : undefined,
      evidenceWorkProductIds: isStringArray(body.evidenceWorkProductIds)
        ? body.evidenceWorkProductIds
        : undefined,
      ...(completionStatus ? { completionStatus } : {}),
    });

    // Re-read the audit row we just wrote so the response shape is symmetric
    // with the idempotent branch (single contract for clients regardless of
    // whether the call was the first or a duplicate).
    const [latestCompletion] = await sql`
      SELECT id, summary, evidence, created_by, created_at
      FROM goal_completions
      WHERE goal_id = ${id}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    return jsonOk({
      goalId: id,
      status: completionResult.status,
      idempotent: false,
      latestCompletion: latestCompletion ?? null,
    });
  } catch (err) {
    // `goalId` may be undefined if the throw happened before `await params` resolved,
    // but in practice that's a Next.js framework failure mode, not a route bug.
    console.error(`[POST /api/goals/[id]/complete] goalId=${goalId ?? "<unresolved>"} error:`, err);
    return jsonError("Failed to complete goal", 500);
  }
}
