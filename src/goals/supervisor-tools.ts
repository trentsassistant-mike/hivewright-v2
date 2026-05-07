import type { Sql } from "postgres";
import type { DecisionOption } from "../db/schema/decisions";
import type { SupervisorTool } from "./types";
import { emitDecisionEvent } from "../dispatcher/event-emitter";
import { parkTaskIfRecoveryBudgetExceeded } from "../recovery/recovery-budget";
import { upsertGoalPlan } from "./goal-documents";
import { completeGoal } from "./completion";

export const SUPERVISOR_TOOLS: SupervisorTool[] = [
  {
    name: "create_task",
    description:
      "Create a task for an executor agent. IMPORTANT: implementation/QA tasks MUST include concrete acceptance_criteria (verifiable checks, evidence expectations). Only research/planning/decision tasks may omit it.",
    parameters: {
      assigned_to: { type: "string", description: "Role slug to assign the task to", required: true },
      title: { type: "string", description: "Task title", required: true },
      brief: { type: "string", description: "Full task brief with context and instructions", required: true },
      acceptance_criteria: {
        type: "string",
        description:
          "Concrete acceptance criteria — what 'done' looks like and how to verify. REQUIRED for implementation, qa, and ops tasks.",
      },
      task_kind: {
        type: "string",
        description:
          "Task category: research | planning | implementation | qa | decision | ops. Defaults to implementation. Only research/planning/decision may omit acceptance_criteria.",
      },
      sourceTaskId: {
        type: "string",
        description:
          "Optional failed/blocked source task id when creating bounded recovery or replacement work. Also accepted as source_task_id.",
      },
      sprint_number: { type: "number", description: "Sprint number for this task", required: true },
      qa_required: { type: "boolean", description: "Whether QA review is needed" },
    },
  },
  {
    name: "create_goal_plan",
    description:
      "Create or update the durable plan document for this goal. Call this BEFORE creating execution tasks. The plan must cover: Goal Summary, Desired Outcome, Success Criteria, Constraints, Risks/Unknowns, Research Needed, Workstreams, Sprint Strategy, Acceptance Rules, Evidence Required. Calling this again updates the existing plan and bumps the revision counter.",
    parameters: {
      title: { type: "string", description: "Plan title (e.g., '<goal title> Plan')", required: true },
      body: {
        type: "string",
        description: "Full markdown plan body with all required sections",
        required: true,
      },
    },
  },
  {
    name: "create_sub_goal",
    description: "Create a sub-goal under the current goal",
    parameters: {
      title: { type: "string", description: "Sub-goal title", required: true },
      description: { type: "string", description: "Full description", required: true },
    },
  },
  {
    name: "create_decision",
    description:
      "Create a decision for the owner (Tier 2 or 3). For genuine multi-way named alternatives, include options[] with stable key, label, consequence/description, and response/canonicalResponse. For auth/runtime/third-party/connector/product-fork route choices, enumerate any technically feasible paths among: add a new credential/key/account/subscription, reuse an existing credential/connector/infrastructure/subscription the hive already has (credentials table, env, Codex auth, Claude Code auth, known paid subscriptions), switch to an already-installed connector/path, and defer. Hiding the reuse-existing path while listing a new key is a known anti-pattern. Keep simple approve/reject decisions as title/context/recommendation without options.",
    parameters: {
      title: { type: "string", description: "Decision title", required: true },
      context: { type: "string", description: "Full explanation", required: true },
      recommendation: { type: "string", description: "What the system recommends" },
      options: {
        type: "array",
        description:
          "Optional named choices for multi-way decisions. Each option should include key, label, consequence or description, and response/canonicalResponse when selecting it should map to a canonical decision response. Include reuse-existing-credential/subscription/infrastructure choices whenever technically feasible.",
      },
      priority: { type: "string", description: "'urgent' or 'normal'" },
      auto_approve: { type: "boolean", description: "Set true for Tier 2 autonomous decisions" },
      sourceTaskId: {
        type: "string",
        description:
          "Optional failed/blocked source task id when creating a recovery decision. Also accepted as source_task_id.",
      },
    },
  },
  {
    name: "create_schedule",
    description: "Propose a recurring schedule for ongoing work",
    parameters: {
      cron_expression: { type: "string", description: "Cron expression", required: true },
      task_template: { type: "object", description: "Task template", required: true },
    },
  },
  {
    name: "mark_goal_achieved",
    description: "Mark the current goal as achieved",
    parameters: {
      summary: { type: "string", description: "Completion summary", required: true },
    },
  },
  {
    name: "get_role_library",
    description: "List all available roles",
    parameters: {},
  },
  {
    name: "query_memory",
    description: "Search the memory system for relevant knowledge about this hive",
    parameters: {
      query: { type: "string", description: "Search query", required: true },
    },
  },
];

export interface ToolResult {
  success: boolean;
  message: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

export async function executeSupervisorTool(
  sql: Sql,
  goalId: string,
  hiveId: string,
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
): Promise<ToolResult> {
  switch (toolName) {
    case "create_task": {
      // Enforce acceptance_criteria for non-research/planning/decision tasks.
      const taskKind = (args.task_kind as string | undefined) ?? "implementation";
      const exemptKinds = new Set(["research", "planning", "decision"]);
      if (!exemptKinds.has(taskKind)) {
        const ac = args.acceptance_criteria as string | undefined;
        if (!ac || ac.trim().length === 0) {
          return {
            success: false,
            message: `create_task rejected: task_kind='${taskKind}' requires non-empty acceptance_criteria. If this is research or planning work, set task_kind='research' or 'planning'.`,
          };
        }
      }

      // Validate delegation — goal-supervisor delegates on behalf of the goal's supervisor role
      const createdBy = args.created_by as string | undefined;
      if (createdBy && createdBy !== "owner" && createdBy !== "ea" && createdBy !== "system" && createdBy !== "goal-supervisor") {
        const [creatorRole] = await sql`
          SELECT delegates_to FROM role_templates WHERE slug = ${createdBy}
        `;
        if (creatorRole) {
          const delegatesTo = typeof creatorRole.delegates_to === "string"
            ? JSON.parse(creatorRole.delegates_to || "[]")
            : (creatorRole.delegates_to || []);
          if (Array.isArray(delegatesTo) && !delegatesTo.includes(args.assigned_to)) {
            return { success: false, message: `Role '${createdBy}' cannot delegate tasks to '${args.assigned_to}'` };
          }
        }
      }
      const [goal] = await sql`
        SELECT project_id FROM goals WHERE id = ${goalId} AND hive_id = ${hiveId}
      `;
      const requestedProjectId = typeof args.projectId === "string" && args.projectId.trim()
        ? args.projectId.trim()
        : null;
      if (requestedProjectId) {
        const [project] = await sql`
          SELECT id FROM projects WHERE id = ${requestedProjectId} AND hive_id = ${hiveId}
        `;
        if (!project) {
          return { success: false, message: `create_task rejected: projectId '${requestedProjectId}' does not belong to this hive.` };
        }
      }
      const projectId = requestedProjectId ?? (goal?.project_id as string | null) ?? null;
      const sourceTask = await resolveSourceTask(sql, hiveId, goalId, args, "create_task");
      if (!sourceTask.ok) return sourceTask.result;
      const parentTaskId = sourceTask.taskId;
      if (parentTaskId) {
        const budget = await parkTaskIfRecoveryBudgetExceeded(sql, parentTaskId, {
          action: "goal-supervisor create_task",
          reason: String(args.title ?? "goal-supervisor replacement task"),
          replacementTasksToCreate: 1,
        });
        if (!budget.ok) {
          return {
            success: false,
            message: budget.reason,
            data: { recoveryBudgetExceeded: true, sourceTaskId: parentTaskId },
          };
        }
      }
      const [task] = await sql`
        INSERT INTO tasks (
          hive_id, assigned_to, created_by, title, brief, acceptance_criteria,
          goal_id, sprint_number, qa_required, project_id, parent_task_id
        )
        VALUES (
          ${hiveId}, ${args.assigned_to}, 'goal-supervisor', ${args.title},
          ${args.brief}, ${args.acceptance_criteria ?? null}, ${goalId},
          ${args.sprint_number}, ${args.qa_required ?? false}, ${projectId},
          ${parentTaskId}
        )
        RETURNING id
      `;
      return { success: true, message: `Task created: ${task.id}`, data: { taskId: task.id } };
    }
    case "create_goal_plan": {
      const title = args.title as string | undefined;
      const body = args.body as string | undefined;
      if (!title || title.trim().length === 0) {
        return { success: false, message: "create_goal_plan requires non-empty title" };
      }
      if (!body || body.trim().length === 0) {
        return { success: false, message: "create_goal_plan requires non-empty body" };
      }
      const plan = await upsertGoalPlan(sql, goalId, {
        title,
        body,
        createdBy: "goal-supervisor",
      });
      return {
        success: true,
        message: `Goal plan ${plan.revision === 1 ? "created" : `updated (revision ${plan.revision})`}`,
        data: { planId: plan.id, revision: plan.revision },
      };
    }
    case "create_sub_goal": {
      const [sg] = await sql`
        INSERT INTO goals (hive_id, parent_id, title, description, status)
        VALUES (${hiveId}, ${goalId}, ${args.title}, ${args.description}, 'active')
        RETURNING id
      `;
      return { success: true, message: `Sub-goal created: ${sg.id}`, data: { goalId: sg.id } };
    }
    case "create_decision": {
      const options = normaliseDecisionOptions(args.options);
      if (args.options !== undefined && !options) {
        return {
          success: false,
          message: "create_decision rejected: options must be an array of objects with non-empty key and label strings.",
        };
      }
      // auto_approve = supervisor declared it doesn't need any judgement at all
      // (Tier 2). Otherwise route through EA-first (the EA may auto-resolve
      // it, or escalate to the owner with rewritten plain-English context).
      const status = args.auto_approve ? "auto_approved" : "ea_review";
      const sourceTask = await resolveSourceTask(sql, hiveId, goalId, args, "create_decision");
      if (!sourceTask.ok) return sourceTask.result;
      const sourceTaskId = sourceTask.taskId;
      if (sourceTaskId && status !== "auto_approved") {
        const budget = await parkTaskIfRecoveryBudgetExceeded(sql, sourceTaskId, {
          action: "goal-supervisor create_decision",
          reason: String(args.title ?? "goal-supervisor recovery decision"),
          recoveryDecisionsToCreate: 1,
        });
        if (!budget.ok) {
          return {
            success: false,
            message: budget.reason,
            data: { recoveryBudgetExceeded: true, sourceTaskId },
          };
        }
      }
      const [d] = await sql`
        INSERT INTO decisions (hive_id, goal_id, task_id, title, context, recommendation, options, priority, status)
        VALUES (${hiveId}, ${goalId}, ${sourceTaskId}, ${args.title}, ${args.context}, ${args.recommendation ?? null}, ${options === undefined ? null : sql.json(options as unknown as Parameters<typeof sql.json>[0])}, ${args.priority ?? "normal"}, ${status})
        RETURNING id
      `;
      // Notification goes through the EA pipeline now — no direct
      // sendNotification here. We still emit the dashboard event so
      // the live decisions stream updates immediately.
      try {
        await emitDecisionEvent(sql, {
          type: "decision_created",
          decisionId: d.id as string,
          title: args.title,
          priority: args.priority ?? "normal",
          hiveId,
        });
      } catch { /* don't fail the tool call if event emission fails */ }
      return { success: true, message: `Decision created: ${d.id}`, data: { decisionId: d.id } };
    }
    case "create_schedule": {
      const [s] = await sql`
        INSERT INTO schedules (hive_id, cron_expression, task_template, created_by)
        VALUES (${hiveId}, ${args.cron_expression}, ${sql.json(args.task_template as Parameters<typeof sql.json>[0])}, 'goal-supervisor')
        RETURNING id
      `;
      return { success: true, message: `Schedule created: ${s.id}`, data: { scheduleId: s.id } };
    }
    case "mark_goal_achieved": {
      const summary = args.summary as string | undefined;
      if (!summary || summary.trim().length === 0) {
        return { success: false, message: "mark_goal_achieved requires non-empty summary" };
      }
      await completeGoal(sql, goalId, summary);
      return { success: true, message: "Goal marked as achieved" };
    }
    case "get_role_library": {
      const roles = await sql`
        SELECT slug, name, department, type, skills
        FROM role_templates
        WHERE active = true
        ORDER BY slug
      `;
      return {
        success: true,
        message: `${roles.length} roles available`,
        data: roles.map((r) => ({
          slug: r.slug,
          name: r.name,
          department: r.department,
          type: r.type,
          skills: r.skills,
        })),
      };
    }
    case "query_memory": {
      const searchPattern = `%${args.query || ""}%`;
      const roleMemory = await sql`
        SELECT content, confidence FROM role_memory
        WHERE hive_id = ${hiveId} AND superseded_by IS NULL AND content ILIKE ${searchPattern}
        ORDER BY updated_at DESC LIMIT 5
      `;
      const hiveMemory = await sql`
        SELECT content, category, confidence FROM hive_memory
        WHERE hive_id = ${hiveId} AND superseded_by IS NULL AND content ILIKE ${searchPattern}
        ORDER BY updated_at DESC LIMIT 5
      `;
      const insights = await sql`
        SELECT content, connection_type, confidence FROM insights
        WHERE hive_id = ${hiveId} AND content ILIKE ${searchPattern}
        ORDER BY updated_at DESC LIMIT 3
      `;
      return {
        success: true,
        message: `Found ${roleMemory.length + hiveMemory.length + insights.length} results`,
        data: {
          roleMemory: roleMemory.map(r => ({ content: r.content, confidence: r.confidence })),
          hiveMemory: hiveMemory.map(r => ({ content: r.content, category: r.category, confidence: r.confidence })),
          insights: insights.map(r => ({ content: r.content, connectionType: r.connection_type, confidence: r.confidence })),
        },
      };
    }
    default:
      return { success: false, message: `Unknown tool: ${toolName}` };
  }
}

type SourceTaskResolution =
  | { ok: true; taskId: string | null }
  | { ok: false; result: ToolResult };

async function resolveSourceTask(
  sql: Sql,
  hiveId: string,
  goalId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: Record<string, any>,
  toolName: string,
): Promise<SourceTaskResolution> {
  const taskId = readSourceTaskId(args);
  if (!taskId) return { ok: true, taskId: null };
  if (!isUuidLike(taskId)) {
    return {
      ok: false,
      result: {
        success: false,
        message: `${toolName} rejected: sourceTaskId '${taskId}' is not a valid task id.`,
      },
    };
  }

  const [task] = await sql`
    SELECT id FROM tasks
    WHERE id = ${taskId}
      AND hive_id = ${hiveId}
      AND goal_id = ${goalId}
  `;
  if (!task) {
    return {
      ok: false,
      result: {
        success: false,
        message: `${toolName} rejected: sourceTaskId '${taskId}' does not belong to this hive goal.`,
      },
    };
  }
  return { ok: true, taskId };
}

// The LLM tool schema uses camelCase, while existing internal callers often
// pass snake_case. Keep both so recovery callers do not need a brittle rename.
function readSourceTaskId(args: Record<string, unknown>): string | null {
  const value = args.sourceTaskId ?? args.source_task_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normaliseDecisionOptions(value: unknown): DecisionOption[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return null;
  const options: DecisionOption[] = [];
  for (const option of value) {
    if (!option || typeof option !== "object" || Array.isArray(option)) return null;
    const record = option as Record<string, unknown>;
    if (typeof record.key !== "string" || record.key.trim() === "") return null;
    if (typeof record.label !== "string" || record.label.trim() === "") return null;
    for (const field of ["consequence", "description", "response", "canonicalResponse", "canonical_response"]) {
      if (record[field] !== undefined && typeof record[field] !== "string") return null;
    }
    options.push({
      key: record.key.trim(),
      label: record.label.trim(),
      consequence: typeof record.consequence === "string" ? record.consequence : undefined,
      description: typeof record.description === "string" ? record.description : undefined,
      response: typeof record.response === "string" ? record.response : undefined,
      canonicalResponse: typeof record.canonicalResponse === "string" ? record.canonicalResponse : undefined,
      canonical_response: typeof record.canonical_response === "string" ? record.canonical_response : undefined,
    });
  }
  return options;
}
