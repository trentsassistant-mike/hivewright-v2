import { sql } from "../_lib/db";
import { jsonOk, jsonError, parseSearchParams } from "../_lib/responses";
import { requireApiUser } from "../_lib/auth";
import { canAccessHive } from "@/auth/users";

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const params = parseSearchParams(request.url);
    const hiveId = params.get("hiveId");
    const search = params.get("q");

    if (!hiveId) return jsonError("hiveId is required", 400);
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this hive", 403);
      }
    }

    if (search) {
      // Search by name
      const rows = await sql`
        SELECT e.id, e.name, e.type, e.attributes,
          (SELECT COUNT(*)::int FROM entity_relationships er WHERE er.from_entity_id = e.id OR er.to_entity_id = e.id) AS connection_count
        FROM entities e
        WHERE e.hive_id = ${hiveId} AND e.name ILIKE ${'%' + search + '%'}
        ORDER BY e.name ASC LIMIT 50
      `;
      return jsonOk(rows.map(r => ({
        id: r.id, name: r.name, type: r.type, attributes: r.attributes, connectionCount: r.connection_count,
      })));
    } else {
      // List all entities
      const rows = await sql`
        SELECT e.id, e.name, e.type, e.attributes,
          (SELECT COUNT(*)::int FROM entity_relationships er WHERE er.from_entity_id = e.id OR er.to_entity_id = e.id) AS connection_count
        FROM entities e
        WHERE e.hive_id = ${hiveId}
        ORDER BY e.name ASC LIMIT 100
      `;
      return jsonOk(rows.map(r => ({
        id: r.id, name: r.name, type: r.type, attributes: r.attributes, connectionCount: r.connection_count,
      })));
    }
  } catch { return jsonError("Failed to fetch entities", 500); }
}
