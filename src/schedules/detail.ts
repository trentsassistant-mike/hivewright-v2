import type { Sql } from "postgres";

type ScheduleTemplate = {
  kind?: string;
  goalId?: string | null;
  assignedTo?: string;
  title?: string;
  brief?: string;
  qaRequired?: boolean;
  priority?: number;
};

type ScheduleRow = {
  id: string;
  hive_id: string;
  cron_expression: string;
  task_template: ScheduleTemplate | string;
  enabled: boolean;
  last_run_at: Date | null;
  next_run_at: Date | null;
  created_by: string;
  created_at: Date;
};

type RoleRow = {
  slug: string;
  name: string;
  department: string | null;
  recommended_model: string | null;
  adapter_type: string;
  skills: unknown;
};

type RunHistoryRow = {
  id: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
};

export type ScheduleDetail = {
  schedule: {
    id: string;
    hiveId: string;
    cronExpression: string;
    taskTemplate: ScheduleTemplate;
    enabled: boolean;
    lastRunAt: Date | string | null;
    nextRunAt: Date | string | null;
    createdBy: string;
    createdAt: Date | string;
  };
  role: {
    slug: string;
    name: string;
    department: string | null;
    recommendedModel: string | null;
    adapterType: string;
    skills: string[];
  } | null;
  runHistory: {
    id: string;
    status: string;
    startedAt: Date | string | null;
    completedAt: Date | string | null;
    createdAt: Date | string;
  }[];
  inProcessRuntime: boolean;
};

export const IN_PROCESS_SCHEDULE_KINDS = new Set([
  "heartbeat",
  "hive-supervisor-heartbeat",
  "ideas",
  "ideas-daily-review",
  "initiative",
  "initiative-evaluation",
  "llm-release",
  "llm-release-scan",
  "current-tech-research-daily",
  "task-quality-feedback-sample",
]);

function parseTemplate(raw: ScheduleRow["task_template"]): ScheduleTemplate {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ScheduleTemplate;
    } catch {
      return {};
    }
  }
  return raw ?? {};
}

function normalizeSkills(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((skill): skill is string => typeof skill === "string");
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return normalizeSkills(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

export async function loadScheduleDetail(
  sql: Sql,
  id: string,
): Promise<ScheduleDetail | null> {
  const [scheduleRow] = await sql<ScheduleRow[]>`
    SELECT id, hive_id, cron_expression, task_template, enabled,
           last_run_at, next_run_at, created_by, created_at
    FROM schedules
    WHERE id = ${id}
    LIMIT 1
  `;

  if (!scheduleRow) return null;

  const template = parseTemplate(scheduleRow.task_template);
  const assignedTo = template.assignedTo ?? null;
  const title = template.title ?? null;
  const kind = template.kind ?? null;
  const inProcessRuntime = Boolean(kind && IN_PROCESS_SCHEDULE_KINDS.has(kind));

  const [roleRow] = assignedTo
    ? await sql<RoleRow[]>`
        SELECT slug, name, department, recommended_model, adapter_type, skills
        FROM role_templates
        WHERE slug = ${assignedTo}
        LIMIT 1
      `
    : [];

  const runHistoryRows =
    assignedTo && title && !inProcessRuntime
      ? await sql<RunHistoryRow[]>`
          SELECT id, status, started_at, completed_at, created_at
          FROM tasks
          WHERE hive_id = ${scheduleRow.hive_id}
            AND created_by = 'scheduler'
            AND assigned_to = ${assignedTo}
            AND title = ${title}
          ORDER BY created_at DESC
          LIMIT 10
        `
      : [];

  return {
    schedule: {
      id: scheduleRow.id,
      hiveId: scheduleRow.hive_id,
      cronExpression: scheduleRow.cron_expression,
      taskTemplate: template,
      enabled: scheduleRow.enabled,
      lastRunAt: scheduleRow.last_run_at,
      nextRunAt: scheduleRow.next_run_at,
      createdBy: scheduleRow.created_by,
      createdAt: scheduleRow.created_at,
    },
    role: roleRow
      ? {
          slug: roleRow.slug,
          name: roleRow.name,
          department: roleRow.department,
          recommendedModel: roleRow.recommended_model,
          adapterType: roleRow.adapter_type,
          skills: normalizeSkills(roleRow.skills),
        }
      : null,
    runHistory: runHistoryRows.map((row) => ({
      id: row.id,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    })),
    inProcessRuntime,
  };
}
