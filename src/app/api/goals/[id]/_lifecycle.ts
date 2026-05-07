import { sql } from "../../_lib/db";
import { jsonOk, jsonError } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import { canMutateHive } from "@/auth/users";
import { pruneGoalSupervisor } from "@/openclaw/goal-supervisor-cleanup";

type GoalLifecycleStatus = "abandoned" | "cancelled";

type GoalLifecycleBody = {
  reason?: unknown;
};

type GoalLifecycleAudit = {
  sourceHiveId: string;
  threadId: string;
  ownerMessageId: string;
  source: string;
};

const TERMINAL_GOAL_STATUSES = new Set(["achieved", "abandoned", "cancelled"]);

function readRequiredAuditHeaders(request: Request):
  | { ok: true; audit: GoalLifecycleAudit }
  | { ok: false; response: Response } {
  const audit = {
    sourceHiveId: request.headers.get("x-hivewright-ea-source-hive-id")?.trim() ?? "",
    threadId: request.headers.get("x-hivewright-ea-thread-id")?.trim() ?? "",
    ownerMessageId: request.headers.get("x-hivewright-ea-owner-message-id")?.trim() ?? "",
    source: request.headers.get("x-hivewright-ea-source")?.trim() ?? "",
  };

  const missing = Object.entries(audit)
    .filter(([, value]) => value.length === 0)
    .map(([key]) => key);

  if (missing.length > 0) {
    return {
      ok: false,
      response: jsonError(
        `Missing required EA audit headers: ${missing.join(", ")}`,
        400,
      ),
    };
  }

  return { ok: true, audit };
}

function parseReason(body: GoalLifecycleBody, status: GoalLifecycleStatus):
  | { ok: true; reason: string | null }
  | { ok: false; response: Response } {
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  if (status === "cancelled" && reason.length === 0) {
    return {
      ok: false,
      response: jsonError("'reason' is required and must be a non-empty string", 400),
    };
  }

  return { ok: true, reason: reason.length > 0 ? reason : null };
}

function lifecycleCommentBody(status: GoalLifecycleStatus, reason: string | null): string {
  const action = status === "abandoned" ? "abandoned" : "cancelled";
  return reason
    ? `Goal ${action}. Reason: ${reason}`
    : `Goal ${action}.`;
}

export async function changeGoalLifecycleStatus(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
  status: GoalLifecycleStatus,
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;

  const auditResult = readRequiredAuditHeaders(request);
  if (!auditResult.ok) return auditResult.response;
  const { audit } = auditResult;

  let goalId: string | undefined;
  try {
    const { id } = await params;
    goalId = id;

    let body: GoalLifecycleBody = {};
    try {
      const rawBody = await request.text();
      body = rawBody.length > 0 ? JSON.parse(rawBody) as GoalLifecycleBody : {};
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const parsedReason = parseReason(body, status);
    if (!parsedReason.ok) return parsedReason.response;

    const [goal] = await sql<{
      id: string;
      hive_id: string;
      title: string;
      status: string;
      session_id: string | null;
    }[]>`
      SELECT id, hive_id, title, status, session_id
      FROM goals
      WHERE id = ${id}
    `;
    if (!goal) return jsonError("Goal not found", 404);

    if (audit.sourceHiveId !== goal.hive_id) {
      return jsonError("Forbidden: EA audit hive does not match this goal", 403);
    }

    if (!user.isSystemOwner) {
      const hasAccess = await canMutateHive(sql, user.id, goal.hive_id);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this goal's hive", 403);
      }
    }

    if (TERMINAL_GOAL_STATUSES.has(goal.status)) {
      return jsonError(
        `Goal cannot be ${status}: current status is '${goal.status}'`,
        409,
      );
    }

    const commentBody = lifecycleCommentBody(status, parsedReason.reason);

    await sql.begin(async (tx) => {
      await tx`
        UPDATE goals
        SET status = ${status}, session_id = NULL, updated_at = NOW()
        WHERE id = ${id}
      `;
      await tx`
        INSERT INTO goal_comments (goal_id, body, created_by)
        VALUES (${id}, ${commentBody}, 'ea')
      `;
    });

    await pruneGoalSupervisor(sql, id);

    return jsonOk({
      goalId: id,
      status,
      previousStatus: goal.status,
      supervisorSessionEnded: goal.session_id !== null,
      audit,
    });
  } catch (err) {
    console.error(
      `[POST /api/goals/[id]/${status === "abandoned" ? "abandon" : "cancel"}] goalId=${goalId ?? "<unresolved>"} error:`,
      err,
    );
    return jsonError(`Failed to ${status === "abandoned" ? "abandon" : "cancel"} goal`, 500);
  }
}
