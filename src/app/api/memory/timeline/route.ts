import { sql } from "../../_lib/db";
import { jsonError, jsonPaginated, parseSearchParams } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import { canAccessHive } from "@/auth/users";

const VALID_STORES = ["role_memory", "hive_memory", "insights"] as const;
type StoreType = (typeof VALID_STORES)[number];

function buildStoreQuery(store: StoreType, hiveId: string) {
  switch (store) {
    case "role_memory":
      return sql`
        SELECT
          id,
          'role_memory' AS store,
          content,
          confidence,
          sensitivity,
          role_slug,
          NULL::varchar AS category,
          NULL::varchar AS connection_type,
          source_task_id,
          created_at
        FROM role_memory
        WHERE hive_id = ${hiveId}
          AND superseded_by IS NULL
      `;
    case "hive_memory":
      return sql`
        SELECT
          id,
          'hive_memory' AS store,
          content,
          confidence,
          sensitivity,
          NULL::varchar AS role_slug,
          category,
          NULL::varchar AS connection_type,
          source_task_id,
          created_at
        FROM hive_memory
        WHERE hive_id = ${hiveId}
          AND superseded_by IS NULL
      `;
    case "insights":
      return sql`
        SELECT
          id,
          'insights' AS store,
          content,
          confidence,
          max_source_sensitivity AS sensitivity,
          NULL::varchar AS role_slug,
          NULL::varchar AS category,
          connection_type,
          NULL::uuid AS source_task_id,
          created_at
        FROM insights
        WHERE hive_id = ${hiveId}
      `;
  }
}

export async function GET(request: Request) {
  try {
    const params = parseSearchParams(request.url);
    const hiveId = params.get("hiveId");
    const store = params.get("store") as StoreType | null;
    const limit = params.getInt("limit", 50);
    const offset = params.getInt("offset", 0);

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

    if (store && !VALID_STORES.includes(store)) {
      return jsonError(
        `Invalid store parameter. Must be one of: ${VALID_STORES.join(", ")}`,
        400,
      );
    }

    const storesToQuery = store ? [store] : [...VALID_STORES];

    // Build the UNION ALL query dynamically
    // We need to use sql.unsafe for the ORDER BY / LIMIT / OFFSET wrapping
    // since postgres.js tagged templates can't compose unions directly.
    // Instead, we query each store and merge in JS (same pattern as memory/search).
    // But for proper pagination with total count, we use a raw UNION ALL.

    if (storesToQuery.length === 1) {
      const storeQuery = storesToQuery[0];
      const countResult = await (storeQuery === "role_memory"
        ? sql`SELECT count(*)::int AS total FROM role_memory WHERE hive_id = ${hiveId} AND superseded_by IS NULL`
        : storeQuery === "hive_memory"
          ? sql`SELECT count(*)::int AS total FROM hive_memory WHERE hive_id = ${hiveId} AND superseded_by IS NULL`
          : sql`SELECT count(*)::int AS total FROM insights WHERE hive_id = ${hiveId}`);

      const total = countResult[0].total;
      const baseQuery = buildStoreQuery(storeQuery, hiveId);
      const rows = await sql`
        SELECT * FROM (${baseQuery}) sub
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

      return jsonPaginated(rows as unknown as Record<string, unknown>[], total, limit, offset);
    }

    // Multiple stores — UNION ALL approach
    const roleQ = buildStoreQuery("role_memory", hiveId);
    const bizQ = buildStoreQuery("hive_memory", hiveId);
    const insightsQ = buildStoreQuery("insights", hiveId);

    const [countResult, rows] = await Promise.all([
      sql`
        SELECT (
          (SELECT count(*) FROM role_memory WHERE hive_id = ${hiveId} AND superseded_by IS NULL) +
          (SELECT count(*) FROM hive_memory WHERE hive_id = ${hiveId} AND superseded_by IS NULL) +
          (SELECT count(*) FROM insights WHERE hive_id = ${hiveId})
        )::int AS total
      `,
      sql`
        SELECT * FROM (
          ${roleQ}
          UNION ALL
          ${bizQ}
          UNION ALL
          ${insightsQ}
        ) combined
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
    ]);

    const total = countResult[0].total;

    return jsonPaginated(rows as unknown as Record<string, unknown>[], total, limit, offset);
  } catch (err) {
    console.error("Memory timeline error:", err);
    return jsonError("Failed to fetch memory timeline", 500);
  }
}
