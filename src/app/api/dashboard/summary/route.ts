import { sql } from "../../_lib/db";
import { requireApiUser } from "../../_lib/auth";
import { canAccessHive } from "@/auth/users";

interface SummaryRow {
  agents_enabled: string;
  tasks_in_progress: string;
  month_spend_cents: string | null;
  pending_approvals: string;
}

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  const url = new URL(request.url);
  const hiveId = url.searchParams.get("hiveId");
  if (!hiveId) {
    return Response.json({ error: "hiveId is required" }, { status: 400 });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hiveId)) {
    return Response.json({ error: "hiveId must be a valid UUID" }, { status: 400 });
  }
  if (!user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, user.id, hiveId);
    if (!hasAccess) {
      return Response.json({ error: "Forbidden: caller cannot access this hive" }, { status: 403 });
    }
  }

  const rows = (await sql`
    SELECT
      (SELECT COUNT(*) FROM role_templates WHERE type = 'executor')               AS agents_enabled,
      (SELECT COUNT(*) FROM tasks
         WHERE hive_id = ${hiveId}::uuid AND status = 'active')            AS tasks_in_progress,
      (SELECT COALESCE(SUM(cost_cents), 0) FROM tasks
         WHERE hive_id = ${hiveId}::uuid
           AND started_at >= date_trunc('month', NOW()))                           AS month_spend_cents,
      (SELECT COUNT(*) FROM decisions
         WHERE hive_id = ${hiveId}::uuid AND status = 'pending')          AS pending_approvals
  `) as unknown as SummaryRow[];

  const row = rows[0];
  return Response.json({
    agentsEnabled: Number(row.agents_enabled),
    tasksInProgress: Number(row.tasks_in_progress),
    monthSpendCents: Number(row.month_spend_cents ?? 0),
    pendingApprovals: Number(row.pending_approvals),
  });
}
