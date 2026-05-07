import { sql } from "../_lib/db";
import { jsonOk, jsonError, parseSearchParams } from "../_lib/responses";
import { requireApiAuth, requireApiUser, requireSystemOwner } from "../_lib/auth";
import { canAccessHive } from "@/auth/users";

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const params = parseSearchParams(request.url);
    const hiveId = params.get("hiveId");
    let rows;
    if (hiveId) {
      if (!user.isSystemOwner) {
        const hasAccess = await canAccessHive(sql, user.id, hiveId);
        if (!hasAccess) {
          return jsonError("Forbidden: caller cannot access this hive", 403);
        }
      }
      rows = await sql`SELECT * FROM adapter_config WHERE hive_id = ${hiveId} OR hive_id IS NULL ORDER BY adapter_type`;
    } else if (user.isSystemOwner) {
      rows = await sql`SELECT * FROM adapter_config ORDER BY adapter_type`;
    } else {
      rows = await sql`
        SELECT * FROM adapter_config
        WHERE hive_id IS NULL
           OR hive_id IN (SELECT hive_id FROM hive_memberships WHERE user_id = ${user.id})
        ORDER BY adapter_type
      `;
    }
    const data = rows.map(r => ({
      id: r.id, hiveId: r.hive_id ?? null, adapterType: r.adapter_type,
      config: r.config, createdAt: r.created_at,
    }));
    return jsonOk(data);
  } catch { return jsonError("Failed to fetch adapter config", 500); }
}

export async function POST(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;
  try {
    const body = await request.json();
    const { hiveId, adapterType, config } = body;
    if (!adapterType || !config) return jsonError("adapterType and config are required", 400);

    // Upsert: update if exists, insert if not. When hiveId is null (global
    // config), postgres-js can't infer the type of a bare null parameter used
    // in `IS NULL`, so we branch the query instead of binding null twice.
    const bid: string | null = hiveId || null;
    const existing = bid === null
      ? await sql`SELECT id FROM adapter_config WHERE adapter_type = ${adapterType} AND hive_id IS NULL`
      : await sql`SELECT id FROM adapter_config WHERE adapter_type = ${adapterType} AND hive_id = ${bid}`;

    if (existing.length > 0) {
      await sql`UPDATE adapter_config SET config = ${sql.json(config)}, updated_at = NOW() WHERE id = ${existing[0].id}`;
      return jsonOk({ id: existing[0].id, updated: true });
    } else {
      const [row] = await sql`
        INSERT INTO adapter_config (hive_id, adapter_type, config)
        VALUES (${hiveId || null}, ${adapterType}, ${sql.json(config)})
        RETURNING id
      `;
      return jsonOk({ id: row.id, created: true }, 201);
    }
  } catch (err) {
    console.error("[adapter-config POST] failed:", err);
    return jsonError("Failed to save adapter config", 500);
  }
}
