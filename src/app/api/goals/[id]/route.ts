import { sql } from "../../_lib/db";
import { jsonOk, jsonError } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import { canAccessHive, canMutateHive } from "@/auth/users";

type GoalRow = {
  id: string;
  hive_id: string;
  parent_id: string | null;
  title: string;
  description: string | null;
  priority: number;
  status: string;
  budget_cents: number | null;
  spent_cents: number;
  session_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type TaskSummaryRow = {
  status: string;
  count: string;
};

type SubGoalRow = {
  id: string;
  title: string;
  status: string;
  created_at: Date;
};

function mapGoalRow(r: GoalRow) {
  return {
    id: r.id,
    hiveId: r.hive_id,
    parentId: r.parent_id,
    title: r.title,
    description: r.description,
    priority: r.priority,
    status: r.status,
    budgetCents: r.budget_cents,
    spentCents: r.spent_cents,
    sessionId: r.session_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;
    const { user } = authz;
    const { id } = await params;

    const goalRows = await sql`
      SELECT id, hive_id, parent_id, title, description, priority, status,
             budget_cents, spent_cents, session_id, created_at, updated_at
      FROM goals
      WHERE id = ${id}
    `;

    if (goalRows.length === 0) {
      return jsonError("Goal not found", 404);
    }

    const goal = mapGoalRow(goalRows[0] as unknown as GoalRow);
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, goal.hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this goal", 403);
      }
    }

    const [taskSummaryRows, subGoalRows] = await Promise.all([
      sql`
        SELECT status, COUNT(*) as count
        FROM tasks
        WHERE goal_id = ${id}
        GROUP BY status
      `,
      sql`
        SELECT id, title, status, created_at
        FROM goals
        WHERE parent_id = ${id}
        ORDER BY created_at ASC
      `,
    ]);

    const taskSummary: Record<string, number> = {};
    for (const row of taskSummaryRows as unknown as TaskSummaryRow[]) {
      taskSummary[row.status] = parseInt(row.count, 10);
    }

    const subGoals = (subGoalRows as unknown as SubGoalRow[]).map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      createdAt: r.created_at,
    }));

    return jsonOk({ ...goal, taskSummary, subGoals });
  } catch {
    return jsonError("Failed to fetch goal", 500);
  }
}

type PatchGoalBody = {
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  status?: unknown;
};

function validatePatchBody(body: PatchGoalBody):
  | {
    ok: true;
    updates: {
      title?: string;
      description?: string | null;
      priority?: number;
    };
  }
  | { ok: false; response: Response } {
  const allowed = new Set(["title", "description", "priority"]);
  const keys = Object.keys(body);
  const disallowed = keys.filter((key) => !allowed.has(key));
  if (disallowed.length > 0) {
    if (disallowed.includes("status")) {
      return {
        ok: false,
        response: jsonError(
          "Status changes must use /api/goals/[id]/abandon, /api/goals/[id]/cancel, or /api/goals/[id]/complete",
          400,
        ),
      };
    }
    return {
      ok: false,
      response: jsonError(`Unsupported goal fields: ${disallowed.join(", ")}`, 400),
    };
  }

  const updates: { title?: string; description?: string | null; priority?: number } = {};

  if (Object.hasOwn(body, "title")) {
    if (typeof body.title !== "string" || body.title.trim().length === 0) {
      return { ok: false, response: jsonError("'title' must be a non-empty string", 400) };
    }
    updates.title = body.title.trim();
  }

  if (Object.hasOwn(body, "description")) {
    if (body.description !== null && typeof body.description !== "string") {
      return { ok: false, response: jsonError("'description' must be a string or null", 400) };
    }
    const description = typeof body.description === "string" ? body.description.trim() : null;
    updates.description = description && description.length > 0 ? description : null;
  }

  if (Object.hasOwn(body, "priority")) {
    if (
      typeof body.priority !== "number" ||
      !Number.isInteger(body.priority) ||
      body.priority < 1 ||
      body.priority > 10
    ) {
      return { ok: false, response: jsonError("'priority' must be an integer from 1 to 10", 400) };
    }
    updates.priority = body.priority;
  }

  if (Object.keys(updates).length === 0) {
    return {
      ok: false,
      response: jsonError("At least one of title, description, or priority is required", 400),
    };
  }

  return { ok: true, updates };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;

  try {
    const { id } = await params;

    let body: PatchGoalBody;
    try {
      body = await request.json() as PatchGoalBody;
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    const validated = validatePatchBody(body);
    if (!validated.ok) return validated.response;

    const [goal] = await sql<{ id: string; hive_id: string }[]>`
      SELECT id, hive_id
      FROM goals
      WHERE id = ${id}
    `;
    if (!goal) {
      return jsonError("Goal not found", 404);
    }

    if (!user.isSystemOwner) {
      const hasAccess = await canMutateHive(sql, user.id, goal.hive_id);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this goal", 403);
      }
    }

    const { title, description, priority } = validated.updates;
    const rows = await sql<GoalRow[]>`
      UPDATE goals
      SET
        title = COALESCE(${title ?? null}, title),
        description = CASE
          WHEN ${Object.hasOwn(validated.updates, "description")} THEN ${description ?? null}
          ELSE description
        END,
        priority = COALESCE(${priority ?? null}, priority),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING id, hive_id, parent_id, title, description, priority, status,
                budget_cents, spent_cents, session_id, created_at, updated_at
    `;

    return jsonOk(mapGoalRow(rows[0]));
  } catch (err) {
    console.error("[PATCH /api/goals/[id]]", err);
    return jsonError("Failed to update goal", 500);
  }
}
