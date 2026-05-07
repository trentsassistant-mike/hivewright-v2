import { canAccessHive } from "@/auth/users";
import { sql } from "../_lib/db";
import { jsonOk, jsonError, parseSearchParams } from "../_lib/responses";
import { requireApiAuth, requireApiUser, requireSystemOwner } from "../_lib/auth";

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const params = parseSearchParams(request.url);
    const hiveId = params.get("hiveId");
    if (!hiveId) return jsonError("hiveId is required", 400);
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this hive", 403);
      }
    }
    const rows = await sql`SELECT id, content, affected_departments, confidence, source_insight_id, created_at, review_at FROM standing_instructions WHERE hive_id = ${hiveId} ORDER BY created_at DESC`;
    const data = rows.map((r) => ({
      id: r.id,
      content: r.content,
      affectedDepartments: r.affected_departments,
      confidence: r.confidence,
      sourceInsightId: r.source_insight_id ?? null,
      createdAt: r.created_at,
      reviewAt: r.review_at ?? null,
    }));
    return jsonOk(data);
  } catch {
    return jsonError("Failed to fetch standing instructions", 500);
  }
}

export async function POST(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;
  try {
    const body = await request.json();
    const { hiveId, content, affectedDepartments } = body;
    if (!hiveId || !content) return jsonError("hiveId and content are required", 400);
    const reviewAt = new Date();
    reviewAt.setDate(reviewAt.getDate() + 90);
    const [row] = await sql`INSERT INTO standing_instructions (hive_id, content, affected_departments, confidence, review_at) VALUES (${hiveId}, ${content}, ${sql.json(affectedDepartments || [])}, 1.0, ${reviewAt}) RETURNING *`;
    return jsonOk(
      {
        id: row.id,
        content: row.content,
        affectedDepartments: row.affected_departments,
        createdAt: row.created_at,
      },
      201,
    );
  } catch {
    return jsonError("Failed to create standing instruction", 500);
  }
}
