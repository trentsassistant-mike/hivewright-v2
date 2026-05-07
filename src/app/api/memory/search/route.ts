import { sql } from "../../_lib/db";
import { jsonOk, jsonError, parseSearchParams } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import { canAccessHive } from "@/auth/users";

export async function GET(request: Request) {
  try {
    const params = parseSearchParams(request.url);
    const hiveId = params.get("hiveId");
    const q = params.get("q");
    const limit = params.getInt("limit", 20);

    if (!hiveId) {
      return jsonError("Missing required parameter: hiveId", 400);
    }
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;
    if (!authz.user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: hive access required", 403);
      }
    }

    const pattern = q ? `%${q}%` : "%";

    const [roleMem, bizMem, insightsMem] = await Promise.all([
      // role_slug must come back so the dashboard can group by role; without
      // it the Memory Health page bucketed every entry under "unknown".
      sql`
        SELECT id, 'role_memory' AS store, content, confidence, sensitivity,
               role_slug, NULL::varchar AS department,
               created_at, updated_at
        FROM role_memory
        WHERE hive_id = ${hiveId}
          AND superseded_by IS NULL
          AND content ILIKE ${pattern}
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `,
      sql`
        SELECT id, 'hive_memory' AS store, content, confidence, sensitivity,
               NULL::varchar AS role_slug, department,
               created_at, updated_at
        FROM hive_memory
        WHERE hive_id = ${hiveId}
          AND superseded_by IS NULL
          AND content ILIKE ${pattern}
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `,
      sql`
        SELECT id, 'insights' AS store, content, confidence, status AS sensitivity,
               NULL::varchar AS role_slug, NULL::varchar AS department,
               created_at, updated_at
        FROM insights
        WHERE hive_id = ${hiveId}
          AND content ILIKE ${pattern}
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `,
    ]);

    const combined = [...roleMem, ...bizMem, ...insightsMem]
      .sort((a, b) => new Date(b.updated_at as string).getTime() - new Date(a.updated_at as string).getTime())
      .slice(0, limit);

    return jsonOk(combined);
  } catch {
    return jsonError("Failed to search memory", 500);
  }
}
