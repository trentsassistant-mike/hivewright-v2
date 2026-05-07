import { canAccessHive } from "@/auth/users";
import { getDecisionActivity } from "@/decisions/activity";
import { sql } from "../../../_lib/db";
import { requireApiUser } from "../../../_lib/auth";
import { jsonError, jsonOk } from "../../../_lib/responses";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;

  try {
    const { id } = await params;
    const [decision] = await sql<{ hive_id: string }[]>`
      SELECT hive_id FROM decisions WHERE id = ${id}
    `;
    if (!decision) return jsonError("Decision not found", 404);
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, decision.hive_id);
      if (!hasAccess) return jsonError("Forbidden: caller cannot access this decision's hive", 403);
    }

    const entries = await getDecisionActivity(sql, id);
    return jsonOk(
      entries.map((entry) => ({
        ...entry,
        timestamp: entry.timestamp,
      })),
    );
  } catch {
    return jsonError("Failed to fetch decision activity", 500);
  }
}
