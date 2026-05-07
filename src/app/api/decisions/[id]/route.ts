import { sql } from "../../_lib/db";
import { jsonOk, jsonError } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import { canAccessHive } from "@/auth/users";
import { AGENT_AUDIT_EVENTS } from "@/audit/agent-events";
import { recordDecisionAuditEvent } from "../_audit";

// Per-handler authorization (audit 2026-04-22 task-area pass).
// Resolving a decision flips the linked `tasks.status` back to 'pending' and
// appends owner-response text into `tasks.brief`. Previously any authenticated
// session could resolve any decision by id and reopen its linked task in an
// unrelated hive. Minimum hardening:
//   1. `requireApiUser()` resolves the caller identity.
//   2. The decision row is looked up first to obtain its `hive_id`; the
//      caller must pass `canAccessHive()` on that hive before the update.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const { id } = await params;
    const body = await request.json();
    const { status, ownerResponse } = body as { status: string; ownerResponse?: string };

    if (status !== "resolved") {
      return jsonError("Only status='resolved' is supported", 400);
    }
    if (!ownerResponse) {
      return jsonError("Missing required field: ownerResponse", 400);
    }

    const [decisionRow] = await sql<{ hiveId: string; goalId: string | null; taskId: string | null }[]>`
      SELECT hive_id AS "hiveId", goal_id AS "goalId", task_id AS "taskId" FROM decisions WHERE id = ${id}
    `;
    if (!decisionRow) {
      return jsonError("Decision not found", 404);
    }
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, decisionRow.hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this decision's hive", 403);
      }
    }

    const rows = await sql`
      UPDATE decisions
      SET status = 'resolved', owner_response = ${ownerResponse}, resolved_at = NOW()
      WHERE id = ${id}
      RETURNING id, task_id
    `;

    if (rows.length === 0) {
      return jsonError("Decision not found", 404);
    }

    const decision = rows[0] as { id: string; task_id: string | null };

    if (decision.task_id) {
      // Cross-hive mutation hardening (audit 2026-04-22): bind the task
      // reopen to the decision's hive so a mismatched decisions.task_id
      // (bad data, future code path) cannot reopen a task in another hive.
      // Caller auth only covers decisionRow.hiveId; tasks in any other
      // hive must be untouched regardless of decisions.task_id state.
      const reopened = await sql`
        UPDATE tasks
        SET
          status = 'pending',
          brief = brief || chr(10) || chr(10) || '## Owner Decision' || chr(10) || ${ownerResponse},
          updated_at = NOW()
        WHERE id = ${decision.task_id} AND hive_id = ${decisionRow.hiveId}
        RETURNING id
      `;
      if (reopened.length === 0) {
        console.error(
          `[PATCH /api/decisions/${id}] task ${decision.task_id} not reopened: ` +
            `hive mismatch with decision hive ${decisionRow.hiveId}`,
        );
        return jsonError("Failed to resolve decision", 500);
      }
    }

    await recordDecisionAuditEvent({
      sql,
      request,
      user,
      eventType: AGENT_AUDIT_EVENTS.decisionResolved,
      decision: {
        id: decision.id,
        hiveId: decisionRow.hiveId,
        goalId: decisionRow.goalId,
        taskId: decisionRow.taskId,
        status: "resolved",
      },
      metadata: {
        source: "decision_patch",
        ownerResponseProvided: true,
        reopenedTask: Boolean(decision.task_id),
      },
    });

    return jsonOk({ id: decision.id, status: "resolved" });
  } catch {
    return jsonError("Failed to resolve decision", 500);
  }
}
