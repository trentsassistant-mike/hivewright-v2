import { sql } from "../_lib/db";
import { requireApiUser } from "../_lib/auth";
import { canAccessHive } from "@/auth/users";

interface TaskRow {
  id: string;
  title: string;
  assigned_to: string;
  created_by: string;
  status: string;
  parent_task_id: string | null;
  goal_id: string | null;
  goal_title: string | null;
  role_name: string | null;
  recommended_model: string | null;
  adapter_type: string | null;
  adapter_override: string | null;
  model_override: string | null;
  started_at: Date | null;
  created_at: Date;
  updated_at: Date;
  model_used: string | null;
}

interface CriticalTaskRow {
  id: string;
  title: string;
  status: string;
  updated_at: Date;
  goal_id: string | null;
  goal_title: string | null;
  goal_status: string | null;
  assigned_to: string | null;
}

interface CriticalDecisionRow {
  id: string;
  title: string;
  status: string;
  created_at: Date;
  goal_id: string | null;
  goal_title: string | null;
  goal_status: string | null;
  task_id: string | null;
}

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const url = new URL(request.url);
  const hiveId = url.searchParams.get("hiveId");
  const includeCritical = url.searchParams.get("includeCritical") === "true";
  if (!hiveId) {
    return Response.json({ error: "hiveId is required" }, { status: 400 });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hiveId)) {
    return Response.json({ error: "hiveId must be a valid UUID" }, { status: 400 });
  }
  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
    if (!hasAccess) {
      return Response.json({ error: "Forbidden: caller cannot access this hive" }, { status: 403 });
    }
  }

  const rows = (await sql`
    SELECT
      t.id,
      t.title,
      t.assigned_to,
      t.created_by,
      t.status,
      t.parent_task_id,
      t.goal_id,
      g.title AS goal_title,
      rt.name AS role_name,
      rt.recommended_model,
      COALESCE(t.adapter_override, rt.adapter_type) AS adapter_type,
      t.adapter_override,
      t.model_override,
      t.started_at,
      t.created_at,
      t.updated_at,
      t.model_used
    FROM tasks t
    LEFT JOIN goals g ON g.id = t.goal_id AND g.hive_id = t.hive_id
    LEFT JOIN role_templates rt ON rt.slug = t.assigned_to
    WHERE t.hive_id = ${hiveId}::uuid
      AND t.status = 'active'
    ORDER BY t.started_at DESC NULLS LAST, t.created_at DESC
  `) as unknown as TaskRow[];

  const response: {
    tasks: ReturnType<typeof mapTaskRow>[];
    criticalItems?: {
      id: string;
      title: string;
      sourceType: "task" | "decision";
      status: string;
      href: string;
      updatedAt: string | null;
      goalId: string | null;
      goalTitle: string | null;
      goalStatus: string | null;
      taskId: string | null;
      assignedTo: string | null;
      liveBlocking: boolean;
    }[];
  } = {
    tasks: rows.map(mapTaskRow),
  };

  if (includeCritical) {
    const criticalTaskRows = (await sql`
      SELECT id, title, status, updated_at, goal_id, goal_title, goal_status, assigned_to
      FROM (
        SELECT
          t.id,
          t.title,
          t.status,
          t.updated_at,
          t.created_at,
          t.assigned_to,
          t.goal_id,
          g.title AS goal_title,
          g.status AS goal_status,
          row_number() OVER (
            PARTITION BY t.status, COALESCE(g.status, 'no-goal')
            ORDER BY t.updated_at DESC, t.created_at DESC
          ) AS status_rank
        FROM tasks t
        LEFT JOIN goals g ON g.id = t.goal_id AND g.hive_id = t.hive_id
        WHERE t.hive_id = ${hiveId}::uuid
          AND t.status IN ('blocked', 'failed', 'unresolvable')
      ) critical_tasks
      WHERE status_rank <= 4
      ORDER BY
        CASE status
          WHEN 'failed' THEN 0
          WHEN 'unresolvable' THEN 1
          WHEN 'blocked' THEN 2
          ELSE 3
        END,
        updated_at DESC,
        created_at DESC
    `) as unknown as CriticalTaskRow[];

    const criticalDecisionRows = (await sql`
      SELECT
        d.id,
        d.title,
        d.status,
        d.created_at,
        d.goal_id,
        d.task_id,
        g.title AS goal_title,
        g.status AS goal_status
      FROM decisions d
      LEFT JOIN goals g ON g.id = d.goal_id AND g.hive_id = d.hive_id
      WHERE d.hive_id = ${hiveId}::uuid
        AND d.status IN ('pending', 'ea_review')
        AND d.is_qa_fixture = false
      ORDER BY
        CASE d.status
          WHEN 'pending' THEN 0
          WHEN 'ea_review' THEN 1
          ELSE 2
        END,
        d.created_at DESC
      LIMIT 12
    `) as unknown as CriticalDecisionRow[];

    response.criticalItems = [
      ...criticalTaskRows.map((row) => ({
        id: row.id,
        title: row.title,
        sourceType: "task" as const,
        status: row.status,
        href: `/tasks/${row.id}`,
        updatedAt: new Date(row.updated_at).toISOString(),
        goalId: row.goal_id,
        goalTitle: row.goal_title,
        goalStatus: row.goal_status,
        taskId: row.id,
        assignedTo: row.assigned_to,
        liveBlocking: isTaskLiveBlocking(row.status, row.goal_status),
      })),
      ...criticalDecisionRows.map((row) => ({
        id: row.id,
        title: row.title,
        sourceType: "decision" as const,
        status: row.status,
        href: `/decisions/${row.id}`,
        updatedAt: new Date(row.created_at).toISOString(),
        goalId: row.goal_id,
        goalTitle: row.goal_title,
        goalStatus: row.goal_status,
        taskId: row.task_id,
        assignedTo: null,
        liveBlocking: isDecisionLiveBlocking(row.goal_status),
      })),
    ];
  }

  return Response.json(response);
}

// A failed/unresolvable/blocked task only blocks live work when the goal it
// belongs to is still active (or it is a direct task with no goal). Failures
// under achieved/cancelled/abandoned/completed goals are kept as historical
// audit context and excluded from the live-critical state.
export function isTaskLiveBlocking(taskStatus: string, goalStatus: string | null): boolean {
  if (!["blocked", "failed", "unresolvable"].includes(taskStatus)) return false;
  if (goalStatus === null) return true;
  return goalStatus === "active";
}

export function isDecisionLiveBlocking(goalStatus: string | null): boolean {
  if (goalStatus === null) return true;
  return goalStatus === "active";
}

function mapTaskRow(r: TaskRow) {
  return {
    id: r.id,
    title: r.title,
    assignedTo: r.assigned_to,
    createdBy: r.created_by,
    status: r.status,
    parentTaskId: r.parent_task_id,
    goalId: r.goal_id,
    goalTitle: r.goal_title,
    roleName: r.role_name,
    recommendedModel: r.recommended_model,
    adapterType: r.adapter_type,
    adapterOverride: r.adapter_override,
    modelOverride: r.model_override,
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    modelUsed: r.model_used,
  };
}
