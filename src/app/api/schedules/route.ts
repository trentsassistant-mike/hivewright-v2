import { sql } from "../_lib/db";
import { jsonOk, jsonError, jsonPaginated, parseSearchParams } from "../_lib/responses";
import { requireApiAuth, requireApiUser, requireSystemOwner } from "../_lib/auth";
import { CronExpressionParser } from "cron-parser";
import { canAccessHive } from "@/auth/users";
import { assertHiveCreationAllowed, creationPausedResponse } from "@/operations/creation-pause";

type ScheduleRow = {
  id: string;
  hive_id: string;
  cron_expression: string;
  task_template: unknown;
  enabled: boolean;
  last_run_at: Date | null;
  next_run_at: Date | null;
  created_by: string;
  created_at: Date;
};

type ScheduleTaskTemplate = {
  assignedTo?: unknown;
  title?: unknown;
  brief?: unknown;
  [key: string]: unknown;
};

function parseScheduleTaskTemplate(raw: unknown): ScheduleTaskTemplate {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parseScheduleTaskTemplate(parsed);
    } catch {
      return {};
    }
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  return raw as ScheduleTaskTemplate;
}

function mapScheduleRow(r: ScheduleRow) {
  return {
    id: r.id,
    hiveId: r.hive_id,
    cronExpression: r.cron_expression,
    taskTemplate: parseScheduleTaskTemplate(r.task_template),
    enabled: r.enabled,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  try {
    const params = parseSearchParams(request.url);
    const hiveId = params.get("hiveId");
    const limit = params.getInt("limit", 50);
    const offset = params.getInt("offset", 0);

    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (hiveId) {
      if (!authz.user.isSystemOwner) {
        const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
        if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
      }
      conditions.push(`hive_id = $${paramIdx++}`);
      values.push(hiveId);
    } else if (!authz.user.isSystemOwner) {
      conditions.push(`hive_id IN (SELECT hive_id FROM hive_memberships WHERE user_id = $${paramIdx++})`);
      values.push(authz.user.id);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countQuery = `SELECT COUNT(*) as total FROM schedules ${whereClause}`;
    const dataQuery = `
      SELECT id, hive_id, cron_expression, task_template, enabled,
             last_run_at, next_run_at, created_by, created_at
      FROM schedules ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `;

    const [countRows, dataRows] = await Promise.all([
      sql.unsafe(countQuery, values as string[]),
      sql.unsafe(dataQuery, [...values, limit, offset] as string[]),
    ]);

    const total = parseInt((countRows[0] as unknown as { total: string }).total, 10);
    const data = (dataRows as unknown as ScheduleRow[]).map(mapScheduleRow);

    return jsonPaginated(data, total, limit, offset);
  } catch {
    return jsonError("Failed to fetch schedules", 500);
  }
}

export async function PATCH(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;
  try {
    const body = await request.json();
    const {
      id,
      enabled,
      cronExpression,
      taskTemplate,
    }: {
      id?: unknown;
      enabled?: unknown;
      cronExpression?: unknown;
      taskTemplate?: ScheduleTaskTemplate;
    } = body;

    if (!id || typeof id !== "string") return jsonError("id is required", 400);

    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (enabled !== undefined) {
      if (typeof enabled !== "boolean") return jsonError("enabled must be a boolean", 400);
      if (enabled) {
        const [schedule] = await sql<{ hive_id: string }[]>`
          SELECT hive_id
          FROM schedules
          WHERE id = ${id}
          LIMIT 1
        `;
        if (!schedule) return jsonError("Schedule not found", 404);
        const pause = await assertHiveCreationAllowed(sql, schedule.hive_id);
        if (pause) return creationPausedResponse(pause);
      }
      updates.push(`enabled = $${idx++}`);
      values.push(enabled);
    }

    if (cronExpression !== undefined) {
      if (typeof cronExpression !== "string" || cronExpression.trim() === "") {
        return jsonError("cronExpression must be a non-empty string", 400);
      }

      let nextRunAt: Date;
      try {
        nextRunAt = CronExpressionParser.parse(cronExpression).next().toDate();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid cron expression";
        return jsonError(`Invalid cronExpression: ${message}`, 400);
      }

      updates.push(`cron_expression = $${idx++}`);
      values.push(cronExpression);
      updates.push(`next_run_at = $${idx++}`);
      values.push(nextRunAt);
    }

    if (taskTemplate !== undefined) {
      if (!taskTemplate || typeof taskTemplate !== "object" || Array.isArray(taskTemplate)) {
        return jsonError("taskTemplate must be an object", 400);
      }
      if (typeof taskTemplate.assignedTo !== "string" || taskTemplate.assignedTo.trim() === "") {
        return jsonError("taskTemplate.assignedTo is required", 400);
      }

      const [role] = await sql`
        SELECT slug FROM role_templates
        WHERE slug = ${taskTemplate.assignedTo}
        LIMIT 1
      `;
      if (!role) return jsonError(`Unknown assigned role: ${taskTemplate.assignedTo}`, 400);

      const taskTemplatePatch: ScheduleTaskTemplate = { ...taskTemplate };
      if (
        typeof taskTemplatePatch.title === "string" &&
        taskTemplatePatch.title.trim() === ""
      ) {
        delete taskTemplatePatch.title;
      }

      updates.push(`task_template = (
        CASE
          WHEN jsonb_typeof(task_template) = 'object' THEN task_template
          WHEN jsonb_typeof(task_template) = 'string' THEN (task_template #>> '{}')::jsonb
          ELSE '{}'::jsonb
        END
      ) || $${idx++}::jsonb`);
      values.push(taskTemplatePatch);
    }

    if (updates.length === 0) return jsonError("Nothing to update", 400);

    values.push(id);
    const rows = await sql.unsafe(
      `
        UPDATE schedules
        SET ${updates.join(", ")}
        WHERE id = $${idx}
        RETURNING id, hive_id, cron_expression, task_template, enabled,
                  last_run_at, next_run_at, created_by, created_at
      `,
      values as string[],
    );
    const row = rows[0] as unknown as ScheduleRow | undefined;
    if (!row) return jsonError("Schedule not found", 404);

    return jsonOk(mapScheduleRow(row));
  } catch { return jsonError("Failed to update schedule", 500); }
}

export async function POST(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;
  try {
    const body = await request.json();
    const { hiveId, cronExpression, taskTemplate, enabled, createdBy } = body;

    if (!hiveId || !cronExpression || !taskTemplate) {
      return jsonError("Missing required fields: hiveId, cronExpression, taskTemplate", 400);
    }
    if (enabled !== undefined && typeof enabled !== "boolean") {
      return jsonError("enabled must be a boolean", 400);
    }

    const scheduleEnabled = enabled ?? true;
    if (scheduleEnabled) {
      const pause = await assertHiveCreationAllowed(sql, hiveId);
      if (pause) return creationPausedResponse(pause);
    }

    const rows = await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, created_by)
      VALUES (
        ${hiveId},
        ${cronExpression},
        ${sql.json(taskTemplate)},
        ${scheduleEnabled},
        ${createdBy ?? "system"}
      )
      RETURNING id, hive_id, cron_expression, task_template, enabled,
                last_run_at, next_run_at, created_by, created_at
    `;

    return jsonOk(mapScheduleRow(rows[0] as unknown as ScheduleRow), 201);
  } catch {
    return jsonError("Failed to create schedule", 500);
  }
}
