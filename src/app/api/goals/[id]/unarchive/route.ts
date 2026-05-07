import { sql } from "../../../_lib/db";
import { jsonOk, jsonError } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { canAccessHive } from "@/auth/users";

// Per-handler authorization (audit 2026-04-22 core-goal pass). Mirrors the
// archive handler: load goal + hive_id, require `canAccessHive()` before the
// state transition. System owners bypass membership via the helper.
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

    if (goal.archived_at === null) {
      return jsonOk({ goalId: id, idempotent: true, archivedAt: null });
    }

    await sql`
      UPDATE goals SET archived_at = NULL, updated_at = NOW()
      WHERE id = ${id}
    `;
    return jsonOk({ goalId: id, idempotent: false, archivedAt: null });
  } catch (err) {
    console.error(`[POST /api/goals/[id]/unarchive]`, err);
    return jsonError("Failed to unarchive goal", 500);
  }
}
