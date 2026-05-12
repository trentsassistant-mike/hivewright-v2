import { canAccessHive } from "@/auth/users";
import { redactActionPayload } from "@/actions/redaction";
import { requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";
import { jsonError, jsonOk } from "../../../_lib/responses";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id } = await ctx.params;
  const [install] = await sql<{ id: string; hive_id: string; connector_slug: string }[]>`
    SELECT id, hive_id, connector_slug
    FROM connector_installs
    WHERE id = ${id}
    LIMIT 1
  `;
  if (!install) return jsonError("install not found", 404);

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, install.hive_id);
    if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
  }

  const limit = Math.min(
    Math.max(Number(new URL(request.url).searchParams.get("limit") ?? 20), 1),
    100,
  );
  const rows = await sql<{
    id: string;
    connector: string;
    operation: string;
    state: string;
    role_slug: string | null;
    policy_id: string | null;
    policy_snapshot: Record<string, unknown> | null;
    request_payload: Record<string, unknown> | null;
    created_at: Date;
    reviewed_at: Date | null;
    executed_at: Date | null;
    completed_at: Date | null;
  }[]>`
    SELECT
      id,
      connector,
      operation,
      state,
      role_slug,
      policy_id,
      policy_snapshot,
      request_payload,
      created_at,
      reviewed_at,
      executed_at,
      completed_at
    FROM external_action_requests
    WHERE hive_id = ${install.hive_id}::uuid
      AND connector = ${install.connector_slug}
      AND execution_metadata->>'installId' = ${id}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;

  return jsonOk(rows.map((row) => ({
    id: row.id,
    connector: row.connector,
    operation: row.operation,
    state: row.state,
    roleSlug: row.role_slug,
    policyId: row.policy_id,
    policyReason: typeof row.policy_snapshot?.reason === "string" ? row.policy_snapshot.reason : null,
    payloadSummary: redactActionPayload(row.request_payload ?? {}),
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    executedAt: row.executed_at,
    completedAt: row.completed_at,
  })));
}
