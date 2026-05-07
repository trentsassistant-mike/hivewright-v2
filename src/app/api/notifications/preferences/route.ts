import { sql } from "../../_lib/db";
import { jsonOk, jsonError, parseSearchParams } from "../../_lib/responses";
import { requireApiAuth, requireApiUser } from "../../_lib/auth";
import { canAccessHive } from "@/auth/users";

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  try {
    const params = parseSearchParams(request.url);
    const hiveId = params.get("hiveId");

    if (!hiveId) {
      return jsonError("hiveId query parameter is required", 400);
    }
    const [hive] = await sql`SELECT id FROM hives WHERE id = ${hiveId}`;
    if (!hive) return jsonError("hive not found", 404);
    if (!authz.user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
      if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
    }

    const rows = await sql`
      SELECT id, hive_id, channel, config, priority_filter, enabled, created_at
      FROM notification_preferences
      WHERE hive_id = ${hiveId}
      ORDER BY created_at DESC
    `;

    const data = rows.map((r) => ({
      id: r.id,
      hiveId: r.hive_id,
      channel: r.channel,
      config: r.config,
      priorityFilter: r.priority_filter,
      enabled: r.enabled,
      createdAt: r.created_at,
    }));

    return jsonOk(data);
  } catch {
    return jsonError("Failed to fetch notification preferences", 500);
  }
}

export async function POST(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  try {
    const body = await request.json();
    const { hiveId, channel, config, priorityFilter, enabled } = body as {
      hiveId?: string;
      channel?: string;
      config?: Record<string, string>;
      priorityFilter?: string;
      enabled?: boolean;
    };

    if (!hiveId || !channel) {
      return jsonError("Missing required fields: hiveId, channel", 400);
    }

    const [row] = await sql`
      INSERT INTO notification_preferences (hive_id, channel, config, priority_filter, enabled)
      VALUES (
        ${hiveId},
        ${channel},
        ${sql.json(config ?? {})},
        ${priorityFilter ?? "all"},
        ${enabled ?? true}
      )
      RETURNING id, hive_id, channel, config, priority_filter, enabled, created_at
    `;

    return jsonOk(
      {
        id: row.id,
        hiveId: row.hive_id,
        channel: row.channel,
        config: row.config,
        priorityFilter: row.priority_filter,
        enabled: row.enabled,
        createdAt: row.created_at,
      },
      201,
    );
  } catch {
    return jsonError("Failed to create notification preference", 500);
  }
}
