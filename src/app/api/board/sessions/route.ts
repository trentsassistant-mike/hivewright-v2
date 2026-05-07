import { sql } from "../../_lib/db";
import { jsonError, jsonOk } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import { canAccessHive } from "@/auth/users";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const hiveId = url.searchParams.get("hiveId");
    if (!hiveId) return jsonError("hiveId is required", 400);
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;
    if (!authz.user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: hive access required", 403);
      }
    }
    const rows = await sql`
      SELECT id, question, status, recommendation, created_at, completed_at
      FROM board_sessions
      WHERE hive_id = ${hiveId}::uuid
      ORDER BY created_at DESC
      LIMIT 25
    `;
    return jsonOk(rows);
  } catch (err) {
    console.error("[api/board/sessions GET]", err);
    return jsonError("Failed to fetch sessions", 500);
  }
}
