import type { Sql } from "postgres";
import { MCP_CATALOG } from "@/tools/mcp-catalog";

type DateLike = Date | string | null;

export type AgentObservabilityRoleRow = {
  slug: string;
  name: string;
  department: string | null;
  type: string;
  tools_config: unknown;
};

export type AgentObservabilityTaskRow = {
  id: string;
  status: string;
  title: string;
  created_at: DateLike;
  started_at: DateLike;
  completed_at: DateLike;
  parent_task_id: string | null;
  goal_id: string | null;
  created_by: string;
  model_used: string | null;
};

export type AgentObservabilityScheduleRow = {
  id: string;
  cron_expression: string;
  enabled: boolean;
  last_run_at: DateLike;
  next_run_at: DateLike;
  task_template: unknown;
};

export type AgentObservabilityConnectorRow = {
  id: string;
  connector_slug: string;
  display_name: string;
  status: string;
  credential_id?: string | null;
  config?: unknown;
};

export type AgentObservabilityRoleMemoryRow = {
  id: string;
  source_task_id: string | null;
  confidence: number;
  sensitivity: string;
  created_at: DateLike;
  updated_at: DateLike;
  content?: string;
};

export type AgentObservabilityHiveMemoryRow = AgentObservabilityRoleMemoryRow & {
  category: string;
};

export type AgentObservabilityAttachmentRow = {
  id: string;
  task_id: string;
  filename: string;
  storage_path?: string;
  mime_type: string | null;
  size_bytes: number;
  uploaded_at: DateLike;
};

export type AgentObservabilityWorkProductRow = {
  id: string;
  task_id: string;
  artifact_kind: string | null;
  file_path: string | null;
  mime_type: string | null;
  sensitivity: string;
  created_at: DateLike;
  content?: string;
  summary?: string | null;
};

export type AgentObservabilityRows = {
  role: AgentObservabilityRoleRow;
  recentTasks: AgentObservabilityTaskRow[];
  schedules: AgentObservabilityScheduleRow[];
  connectorInstalls: AgentObservabilityConnectorRow[];
  roleMemory: AgentObservabilityRoleMemoryRow[];
  hiveMemory: AgentObservabilityHiveMemoryRow[];
  taskAttachments: AgentObservabilityAttachmentRow[];
  workProducts: AgentObservabilityWorkProductRow[];
  hiveId?: string | null;
};

export type AgentObservability = ReturnType<typeof mapAgentObservabilityRows>;

const MCP_LABELS = new Map(MCP_CATALOG.map((entry) => [entry.slug, entry.label]));

function dateOut(value: DateLike): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function parseToolsConfig(raw: unknown): { mcps?: string[] } | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return parseToolsConfig(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object") return null;
  const value = raw as { mcps?: unknown };
  if (!Array.isArray(value.mcps)) return {};
  return { mcps: value.mcps.filter((item): item is string => typeof item === "string") };
}

function parseScheduleTemplate(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return parseScheduleTemplate(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

function safeFileLabel(filePath: string | null, fallback: string): string {
  if (!filePath) return fallback;
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || fallback;
}

export function mapAgentObservabilityRows(rows: AgentObservabilityRows) {
  const statusCounts = rows.recentTasks.reduce<Record<string, number>>((counts, task) => {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
    return counts;
  }, {});

  const toolsConfig = parseToolsConfig(rows.role.tools_config);
  const tools = toolsConfig?.mcps === undefined
    ? [{ slug: "runtime-default", label: "Runtime default tool policy", source: "runtime-default" as const }]
    : toolsConfig.mcps.map((slug) => ({
        slug,
        label: MCP_LABELS.get(slug) ?? slug,
        source: "role-mcp" as const,
      }));

  const scheduleItems = rows.schedules.map((schedule) => {
    const template = parseScheduleTemplate(schedule.task_template);
    return {
      id: schedule.id,
      cronExpression: schedule.cron_expression,
      enabled: Boolean(schedule.enabled),
      lastRunAt: dateOut(schedule.last_run_at),
      nextRunAt: dateOut(schedule.next_run_at),
      kind: typeof template.kind === "string" ? template.kind : null,
      title: typeof template.title === "string" ? template.title : null,
    };
  });

  return {
    role: {
      slug: rows.role.slug,
      name: rows.role.name,
      department: rows.role.department,
      type: rows.role.type,
    },
    scope: {
      hiveId: rows.hiveId ?? null,
    },
    history: {
      agentLevel: {
        historyLevel: "agent" as const,
        totalRuns: rows.recentTasks.length,
        statusCounts,
        lastRunAt: dateOut(rows.recentTasks[0]?.created_at ?? null),
      },
      taskLevel: rows.recentTasks.map((task) => ({
        historyLevel: "task" as const,
        id: task.id,
        title: task.title,
        status: task.status,
        createdAt: dateOut(task.created_at),
        startedAt: dateOut(task.started_at),
        completedAt: dateOut(task.completed_at),
        parentTaskId: task.parent_task_id,
        goalId: task.goal_id,
        createdBy: task.created_by,
        modelUsed: task.model_used,
      })),
      emptyMessage: rows.recentTasks.length === 0
        ? "No agent-level run history has been recorded for this role."
        : null,
    },
    scheduleState: scheduleItems.length === 0
      ? {
          kind: "no_schedule" as const,
          label: "No schedule",
          message: "No schedule is configured for this agent in the selected scope.",
          schedules: [],
        }
      : {
          kind: "scheduled" as const,
          label: `${scheduleItems.length} schedule${scheduleItems.length === 1 ? "" : "s"}`,
          message: null,
          schedules: scheduleItems,
        },
    tools,
    toolsEmptyMessage: tools.length === 0 ? "No explicit MCP tools are configured for this role." : null,
    connectedApps: rows.connectorInstalls.map((install) => ({
      id: install.id,
      connectorSlug: install.connector_slug,
      displayName: install.display_name,
      status: install.status,
    })),
    connectedAppsEmptyMessage: rows.connectorInstalls.length === 0
      ? "No connected apps are installed in the selected hive."
      : null,
    memory: {
      roleMemory: rows.roleMemory.map((memory) => ({
        id: memory.id,
        sourceTaskId: memory.source_task_id,
        confidence: memory.confidence,
        sensitivity: memory.sensitivity,
        createdAt: dateOut(memory.created_at),
        updatedAt: dateOut(memory.updated_at),
      })),
      hiveMemory: rows.hiveMemory.map((memory) => ({
        id: memory.id,
        sourceTaskId: memory.source_task_id,
        category: memory.category,
        confidence: memory.confidence,
        sensitivity: memory.sensitivity,
        createdAt: dateOut(memory.created_at),
        updatedAt: dateOut(memory.updated_at),
      })),
      emptyMessage: rows.roleMemory.length === 0 && rows.hiveMemory.length === 0
        ? "No linked memory metadata is available for this agent."
        : null,
    },
    files: {
      attachments: rows.taskAttachments.map((attachment) => ({
        id: attachment.id,
        taskId: attachment.task_id,
        filename: attachment.filename,
        mimeType: attachment.mime_type,
        sizeBytes: attachment.size_bytes,
        uploadedAt: dateOut(attachment.uploaded_at),
      })),
      workProducts: rows.workProducts.map((workProduct) => ({
        id: workProduct.id,
        taskId: workProduct.task_id,
        artifactKind: workProduct.artifact_kind,
        fileLabel: safeFileLabel(workProduct.file_path, workProduct.artifact_kind ?? "work product"),
        mimeType: workProduct.mime_type,
        sensitivity: workProduct.sensitivity,
        createdAt: dateOut(workProduct.created_at),
      })),
      emptyMessage: rows.taskAttachments.length === 0 && rows.workProducts.length === 0
        ? "No linked file or artifact metadata is available for this agent."
        : null,
    },
  };
}

function scopedCondition(column: string, values: unknown[], hiveId?: string | null) {
  if (!hiveId) return "";
  values.push(hiveId);
  return ` AND ${column} = $${values.length}`;
}

export async function loadAgentObservability(
  sql: Sql,
  roleSlug: string,
  options: { hiveId?: string | null } = {},
): Promise<AgentObservability | null> {
  const [role] = await sql<AgentObservabilityRoleRow[]>`
    SELECT slug, name, department, type, tools_config
    FROM role_templates
    WHERE slug = ${roleSlug}
    LIMIT 1
  `;
  if (!role) return null;

  const taskValues: unknown[] = [roleSlug];
  const taskHiveCondition = scopedCondition("hive_id", taskValues, options.hiveId);
  const recentTasks = await sql.unsafe(
    `
      SELECT id, status, title, created_at, started_at, completed_at,
             parent_task_id, goal_id, created_by, model_used
      FROM tasks
      WHERE assigned_to = $1${taskHiveCondition}
      ORDER BY created_at DESC
      LIMIT 10
    `,
    taskValues as string[],
  ) as AgentObservabilityTaskRow[];

  const scheduleValues: unknown[] = [roleSlug];
  const scheduleHiveCondition = scopedCondition("hive_id", scheduleValues, options.hiveId);
  const schedules = await sql.unsafe(
    `
      SELECT id, cron_expression, enabled, last_run_at, next_run_at, task_template
      FROM schedules
      WHERE task_template->>'assignedTo' = $1${scheduleHiveCondition}
      ORDER BY COALESCE(next_run_at, last_run_at, created_at) DESC
      LIMIT 5
    `,
    scheduleValues as string[],
  ) as AgentObservabilityScheduleRow[];

  const connectorInstalls = options.hiveId
    ? await sql<AgentObservabilityConnectorRow[]>`
        SELECT id, connector_slug, display_name, status
        FROM connector_installs
        WHERE hive_id = ${options.hiveId}
          AND status <> 'archived'
        ORDER BY display_name ASC
        LIMIT 12
      `
    : [];

  const roleMemoryValues: unknown[] = [roleSlug];
  const roleMemoryHiveCondition = scopedCondition("hive_id", roleMemoryValues, options.hiveId);
  const roleMemory = await sql.unsafe(
    `
      SELECT id, source_task_id, confidence, sensitivity, created_at, updated_at
      FROM role_memory
      WHERE role_slug = $1
        AND superseded_by IS NULL${roleMemoryHiveCondition}
      ORDER BY updated_at DESC
      LIMIT 6
    `,
    roleMemoryValues as string[],
  ) as AgentObservabilityRoleMemoryRow[];

  const hiveMemoryValues: unknown[] = [roleSlug];
  const hiveMemoryHiveCondition = scopedCondition("hm.hive_id", hiveMemoryValues, options.hiveId);
  const hiveMemory = await sql.unsafe(
    `
      SELECT hm.id, hm.source_task_id, hm.category, hm.confidence, hm.sensitivity,
             hm.created_at, hm.updated_at
      FROM hive_memory hm
      INNER JOIN tasks t ON t.id = hm.source_task_id
      WHERE t.assigned_to = $1
        AND hm.superseded_by IS NULL${hiveMemoryHiveCondition}
      ORDER BY hm.updated_at DESC
      LIMIT 6
    `,
    hiveMemoryValues as string[],
  ) as AgentObservabilityHiveMemoryRow[];

  const attachmentValues: unknown[] = [roleSlug];
  const attachmentHiveCondition = scopedCondition("t.hive_id", attachmentValues, options.hiveId);
  const taskAttachments = await sql.unsafe(
    `
      SELECT ta.id, ta.task_id, ta.filename, ta.mime_type, ta.size_bytes, ta.uploaded_at
      FROM task_attachments ta
      INNER JOIN tasks t ON t.id = ta.task_id
      WHERE t.assigned_to = $1${attachmentHiveCondition}
      ORDER BY ta.uploaded_at DESC
      LIMIT 8
    `,
    attachmentValues as string[],
  ) as AgentObservabilityAttachmentRow[];

  const workProductValues: unknown[] = [roleSlug];
  const workProductHiveCondition = scopedCondition("hive_id", workProductValues, options.hiveId);
  const workProducts = await sql.unsafe(
    `
      SELECT id, task_id, artifact_kind, file_path, mime_type, sensitivity, created_at
      FROM work_products
      WHERE role_slug = $1${workProductHiveCondition}
      ORDER BY created_at DESC
      LIMIT 8
    `,
    workProductValues as string[],
  ) as AgentObservabilityWorkProductRow[];

  return mapAgentObservabilityRows({
    role,
    recentTasks,
    schedules,
    connectorInstalls,
    roleMemory,
    hiveMemory,
    taskAttachments,
    workProducts,
    hiveId: options.hiveId ?? null,
  });
}
