import { sql } from "../../../_lib/db";
import { jsonOk, jsonError } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { canAccessHive } from "@/auth/users";

// Per-handler authorization (audit 2026-04-22 core-goal pass).
// Archive flips a goal out of active listings. Previously any authenticated
// session could archive any goal by id. Minimum hardening: resolve caller via
// `requireApiUser()`, load the goal's `hive_id`, and require `canAccessHive()`
// on that hive before the update. System owners bypass membership via the
// helper itself.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const { id } = await params;
    const [goal] = await sql<{ id: string; hive_id: string; archived_at: Date | null }[]>`
      SELECT id, hive_id, archived_at FROM goals WHERE id = ${id}
    `;
    if (!goal) return jsonError("Goal not found", 404);

    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, goal.hive_id);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this goal's hive", 403);
      }
    }

    if (goal.archived_at !== null) {
      return jsonOk({ goalId: id, idempotent: true, archivedAt: goal.archived_at });
    }

    const [row] = await sql<{ archived_at: Date }[]>`
      UPDATE goals SET archived_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
      RETURNING archived_at
    `;
    return jsonOk({ goalId: id, idempotent: false, archivedAt: row.archived_at });
  } catch (err) {
    console.error(`[POST /api/goals/[id]/archive]`, err);
    return jsonError("Failed to archive goal", 500);
  }
}
