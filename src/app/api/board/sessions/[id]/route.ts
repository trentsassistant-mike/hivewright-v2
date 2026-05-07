import { sql } from "../../../_lib/db";
import { jsonError, jsonOk } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { canAccessHive } from "@/auth/users";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;
    const { id } = await ctx.params;
    const [session] = await sql`
      SELECT id, hive_id, question, status, recommendation, error_text, created_at, completed_at
      FROM board_sessions WHERE id = ${id}
    `;
    if (!session) return jsonError("session not found", 404);
    if (!authz.user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, authz.user.id, session.hive_id as string);
      if (!hasAccess) {
        return jsonError("Forbidden: hive access required", 403);
      }
    }
    const turns = await sql`
      SELECT member_slug, member_name, content, order_index, created_at
      FROM board_turns WHERE session_id = ${id}
      ORDER BY order_index ASC
    `;
    return jsonOk({ session, turns });
  } catch (err) {
    console.error("[api/board/sessions/:id GET]", err);
    return jsonError("Failed to fetch session", 500);
  }
}
