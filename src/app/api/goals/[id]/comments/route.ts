import { sql } from "@/app/api/_lib/db";
import { jsonOk, jsonError } from "@/app/api/_lib/responses";
import { isInternalServiceAccountUser, requireApiUser } from "@/app/api/_lib/auth";
import { canAccessHive, canMutateHive } from "@/auth/users";

type CommentRow = {
  id: string;
  goal_id: string;
  body: string;
  created_by: string;
  created_at: Date;
};

function mapComment(r: CommentRow) {
  return {
    id: r.id,
    goalId: r.goal_id,
    body: r.body,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const { id } = await params;
    const [goal] = await sql<{ id: string; hive_id: string }[]>`
      SELECT id, hive_id FROM goals WHERE id = ${id}
    `;
    if (!goal) {
      return jsonError("Goal not found", 404);
    }
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, goal.hive_id);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this goal", 403);
      }
    }

    const rows = await sql<CommentRow[]>`
      SELECT id, goal_id, body, created_by, created_at
      FROM goal_comments
      WHERE goal_id = ${id}
      ORDER BY created_at ASC
    `;
    return jsonOk({ comments: rows.map(mapComment) });
  } catch {
    return jsonError("Failed to fetch comments", 500);
  }
}

function resolveSupervisorAttribution(
  request: Request,
  goal: { session_id: string | null },
  callerCreatedBy: string,
): string | null {
  const callerSession =
    request.headers.get("x-supervisor-session")?.trim() ?? "";
  const supervisorMatch =
    callerSession.length > 0 && callerSession === goal.session_id;
  if (!supervisorMatch) return null;
  return callerCreatedBy.length > 0 ? callerCreatedBy : "goal-supervisor";
}

// Per-handler authorization (audit 2026-04-22 goal-adjacent pass).
// Previously any authenticated session could append a comment to any goal
// and set arbitrary `createdBy` labels including `goal-supervisor`. Minimum
// hardening:
//   1. `requireApiUser()` resolves the caller identity.
//   2. Load goal with `hive_id` + `session_id`.
//   3. Accept one of four auth branches:
//      - internal service account (EA-resolver, dispatcher-spawned agents):
//        treated as system-owner for access, but authorship defaults to
//        "system" and "owner" is rejected — these subsystems must not be
//        able to mint owner-attributed comments. Supervisor-session header
//        still wins for goal supervisors that authenticate via the bearer.
//      - matching `X-Supervisor-Session` header against `goals.session_id`:
//        supervisor is the legitimate authorship principal, so the
//        caller-supplied `createdBy` is honored (default "goal-supervisor").
//      - human system owner: honors caller-supplied `createdBy` (default
//        "owner").
//      - hive writer (via `canMutateHive()`): allowed to comment but
//        `createdBy` is forced to "system" to prevent spoofed role-slug
//        authorship ("owner", "goal-supervisor") by non-privileged members.
//      - else: 403.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const { id } = await params;

    const body = await request.json();
    const commentBody = typeof body?.body === "string" ? body.body.trim() : "";
    const callerCreatedBy =
      typeof body?.createdBy === "string" ? body.createdBy.trim() : "";

    if (!commentBody) {
      return jsonError("body is required", 400);
    }

    const [goal] = await sql<
      { id: string; hive_id: string; session_id: string | null }[]
    >`SELECT id, hive_id, session_id FROM goals WHERE id = ${id}`;
    if (!goal) {
      return jsonError("Goal not found", 404);
    }

    let effectiveCreatedBy: string;
    if (isInternalServiceAccountUser(user)) {
      const supervisorAttribution = resolveSupervisorAttribution(
        request,
        goal,
        callerCreatedBy,
      );
      if (supervisorAttribution) {
        effectiveCreatedBy = supervisorAttribution;
      } else if (
        callerCreatedBy.length > 0 &&
        callerCreatedBy.toLowerCase() !== "owner"
      ) {
        effectiveCreatedBy = callerCreatedBy;
      } else {
        // EA-resolver / dispatcher-spawned agents authenticate via the
        // internal service token but are NOT the owner. Defaulting their
        // comments to "owner" falsely attributed an EA approval to the
        // owner (incident: decision f03b884d). Force "system" attribution
        // and reject any caller-supplied "owner" label.
        effectiveCreatedBy = "system";
      }
    } else if (user.isSystemOwner) {
      effectiveCreatedBy = callerCreatedBy.length > 0 ? callerCreatedBy : "owner";
    } else {
      const supervisorAttribution = resolveSupervisorAttribution(
        request,
        goal,
        callerCreatedBy,
      );
      if (supervisorAttribution) {
        effectiveCreatedBy = supervisorAttribution;
      } else {
        const hasAccess = await canMutateHive(sql, user.id, goal.hive_id);
        if (!hasAccess) {
          return jsonError(
            "Forbidden: caller cannot access this goal",
            403,
          );
        }
        effectiveCreatedBy = "system";
      }
    }

    const rows = await sql<CommentRow[]>`
      INSERT INTO goal_comments (goal_id, body, created_by)
      VALUES (${id}, ${commentBody}, ${effectiveCreatedBy})
      RETURNING id, goal_id, body, created_by, created_at
    `;

    return jsonOk({ comment: mapComment(rows[0]) }, 201);
  } catch {
    return jsonError("Failed to create comment", 500);
  }
}
