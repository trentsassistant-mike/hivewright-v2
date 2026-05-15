import type { Sql } from "postgres";
import type { DecisionOption } from "../db/schema/decisions";
import type { SupervisorTool } from "./types";
import {
  AGENT_AUDIT_EVENTS,
  recordAgentAuditEventBestEffort,
} from "../audit/agent-events";
import { emitDecisionEvent } from "../dispatcher/event-emitter";
import { parkTaskIfRecoveryBudgetExceeded } from "../recovery/recovery-budget";
import { upsertGoalPlan } from "./goal-documents";
import {
  completeGoal,
  parseCompletionEvidenceBundle,
  parseGoalCompletionStatus,
} from "./completion";
import { startPipelineRun } from "../pipelines/service";
import {
  LEARNING_GATE_CATEGORIES,
  hasOutcomeClassificationInput,
  parseLearningGateResult,
  parseOutcomeClassificationRecord,
  recordGoalOutcomeClassification,
} from "./outcome-records";

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
      "Create or update the durable outcome plan for this goal. Call this BEFORE creating execution tasks. The plan must cover: Goal Summary, Desired Outcome, Outcome Classification (outcome-led or process-bound), Applicable Policies / Rules / Pipelines, Professional Process Inferred, Success Criteria, Constraints, Risks/Unknowns, Research Needed, Workstreams, Sprint Strategy, Acceptance Rules, Evidence Required, and Learning Gate Plan. Calling this again updates the existing plan and bumps the revision counter.",
    parameters: {
      title: { type: "string", description: "Plan title (e.g., '<goal title> Plan')", required: true },
      body: {
        type: "string",
        description: "Full markdown plan body with all required sections",
        required: true,
      },
      outcome_classification: {
        type: "string",
        description: "Optional structured classification for this goal: outcome-led or process-bound",
      },
      classification_rationale: {
        type: "string",
        description: "Required when outcome_classification is supplied; why this goal is outcome-led or process-bound",
      },
      applicable_references: {
        type: "array",
        description:
          "Optional policy/rule/pipeline references that apply to a process-bound classification. Each item should include type plus id, slug, title, source, or note where available.",
      },
    },
  },
  {
    name: "record_outcome_classification",
    description:
      "Persist the supervisor's classification of this goal as outcome-led or process-bound, with rationale and any applicable policy/rule/pipeline references. Use this after checking memory, rules, standing instructions, and pipeline templates, and before creating execution work.",
    parameters: {
      classification: {
        type: "string",
        description: "Exactly one of: outcome-led, process-bound",
        required: true,
      },
      rationale: {
        type: "string",
        description: "Why this classification applies to the goal",
        required: true,
      },
      references: {
        type: "array",
        description:
          "Applicable policy/rule/pipeline references where available. Each item should include type plus id, slug, title, source, or note.",
      },
    },
  },
  {
    name: "list_pipeline_templates",
    description:
      "List active governed pipeline templates available to this hive so the supervisor can check whether the outcome is process-bound. Use this to find mandatory owner processes, owner-approved repeatable procedures, or high-confidence procedures where order/evidence/approval matters — not as a blanket requirement to pipeline all work.",
    parameters: {},
  },
  {
    name: "start_pipeline_run",
    description:
      "Start a selected active pipeline template for this goal/sprint when it materially fits because it is a mandatory owner process, owner-approved repeatable process, or process-bound procedure where order/evidence/approval matters. Requires a clear selection_rationale; do not use pipelines just because a template loosely resembles outcome-led exploratory work.",
    parameters: {
      template_id: { type: "string", description: "Pipeline template id selected from list_pipeline_templates", required: true },
      source_task_id: { type: "string", description: "Optional existing source work-task id; also accepted as sourceTaskId" },
      source_context: { type: "string", description: "Source work context if no source task exists, or extra context for the pipeline" },
      sprint_number: { type: "number", description: "Sprint number this pipeline should count toward for supervisor wake-up", required: true },
      selection_rationale: { type: "string", description: "Why this template fits the current goal work", required: true },
      confidence: { type: "number", description: "Supervisor confidence from 0 to 1" },
    },
  },
  {
    name: "propose_pipeline_template",
    description:
      "Create a draft governed sub-goal to design a new reusable pipeline when no active template fits but the work may deserve a repeatable process. This is a self-evolution path: propose/design/dry-run/promote with owner approval before any policy or pipeline becomes mandatory — not uncontrolled production mutation.",
    parameters: {
      title: { type: "string", description: "Sub-goal title for the new reusable pipeline", required: true },
      need: { type: "string", description: "Why existing templates do not fit", required: true },
      proposed_steps: { type: "array", description: "Initial proposed pipeline step names/slugs", required: true },
      evidence: { type: "string", description: "Evidence/rationale from template review", required: true },
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
    description:
      "Mark the current goal as achieved only after success criteria are satisfied. Evidence is required: do not mark a goal achieved without evidence proving the outcome is complete. Include artifact paths/URLs, test results, review notes, screenshots, decision IDs, or comparable proof, plus the lightweight Learning Gate result from the completion review.",
    parameters: {
      summary: { type: "string", description: "Completion summary", required: true },
      completion_status: {
        type: "string",
        description:
          "Optional structured final state: achieved, execution_ready, or blocked_on_owner_channel. Use blocked_on_owner_channel when the package is ready but owner-controlled sending/channel approval is still required.",
      },
      evidence: {
        type: "array",
        description:
          "REQUIRED evidence bundle. Each item must include type and description plus a non-empty reference or value. Use artifact paths/URLs, test command/results, review notes, screenshots, decision IDs, work-product IDs, or other proof that completion was verified.",
        required: true,
      },
      learning_gate: {
        type: "object",
        description: `Learning Gate result with category (${LEARNING_GATE_CATEGORIES.join(" | ")}), rationale, optional action, and optional references.`,
      },
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
      const pipelineGate = await rejectDirectContentTaskWhenPipelineFits(sql, hiveId, args, taskKind);
      if (pipelineGate) return pipelineGate;
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
      const classification = hasOutcomeClassificationInput(args)
        ? parseOutcomeClassificationRecord(args)
        : null;
      if (classification && !classification.ok) {
        return { success: false, message: `create_goal_plan rejected: ${classification.error}` };
      }
      const plan = await upsertGoalPlan(sql, goalId, {
        title,
        body,
        createdBy: "goal-supervisor",
      });
      if (classification?.ok) {
        const recorded = await recordGoalOutcomeClassification(sql, goalId, classification.record);
        if (!recorded) {
          return { success: false, message: `create_goal_plan persisted but failed to classify missing goal: ${goalId}` };
        }
      }
      return {
        success: true,
        message: `Goal plan ${plan.revision === 1 ? "created" : `updated (revision ${plan.revision})`}`,
        data: {
          planId: plan.id,
          revision: plan.revision,
          outcomeClassification: classification?.ok ? classification.record.classification : undefined,
        },
      };
    }
    case "record_outcome_classification": {
      const parsed = parseOutcomeClassificationRecord(args);
      if (!parsed.ok) {
        return { success: false, message: `record_outcome_classification rejected: ${parsed.error}` };
      }
      const recorded = await recordGoalOutcomeClassification(sql, goalId, parsed.record);
      if (!recorded) return { success: false, message: `Goal not found: ${goalId}` };
      return {
        success: true,
        message: `Goal classified as ${parsed.record.classification}`,
        data: {
          classification: parsed.record.classification,
          references: parsed.record.references,
        },
      };
    }
    case "list_pipeline_templates": {
      const templates = await sql`
        SELECT
          pt.id,
          pt.scope,
          pt.hive_id,
          pt.slug,
          pt.name,
          pt.department,
          pt.description,
          pt.mode,
          pt.version,
          pt.max_total_cost_cents,
          pt.final_output_contract,
          COUNT(ps.id)::int AS step_count,
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'order', ps.step_order,
                'slug', ps.slug,
                'name', ps.name,
                'roleSlug', ps.role_slug,
                'duty', ps.duty,
                'acceptanceCriteria', ps.acceptance_criteria,
                'outputContract', ps.output_contract
              ) ORDER BY ps.step_order ASC
            ) FILTER (WHERE ps.id IS NOT NULL),
            '[]'::jsonb
          ) AS steps
        FROM pipeline_templates pt
        LEFT JOIN pipeline_steps ps ON ps.template_id = pt.id
        WHERE pt.active = true
          AND (pt.scope = 'global' OR pt.hive_id = ${hiveId})
        GROUP BY pt.id
        ORDER BY pt.department ASC, pt.name ASC, pt.version DESC
      `;
      return {
        success: true,
        message: `${templates.length} active pipeline template(s) available`,
        data: templates.map((t) => ({
          id: t.id,
          scope: t.scope,
          hiveId: t.hive_id,
          slug: t.slug,
          name: t.name,
          department: t.department,
          description: t.description,
          mode: t.mode,
          version: t.version,
          maxTotalCostCents: t.max_total_cost_cents,
          finalOutputContract: t.final_output_contract,
          stepCount: Number(t.step_count ?? 0),
          steps: t.steps,
        })),
      };
    }
    case "start_pipeline_run": {
      const templateId = readStringArg(args, "template_id") ?? readStringArg(args, "templateId");
      const sprintNumber = readNumberArg(args, "sprint_number") ?? readNumberArg(args, "sprintNumber");
      const selectionRationale = readStringArg(args, "selection_rationale") ?? readStringArg(args, "selectionRationale");
      if (!templateId) return { success: false, message: "start_pipeline_run requires template_id" };
      if (!Number.isInteger(sprintNumber) || (sprintNumber as number) < 1) {
        return { success: false, message: "start_pipeline_run requires positive integer sprint_number" };
      }
      if (!selectionRationale) return { success: false, message: "start_pipeline_run requires selection_rationale" };
      const sourceTask = await resolveSourceTask(sql, hiveId, goalId, args, "start_pipeline_run");
      if (!sourceTask.ok) return sourceTask.result;
      const sourceTaskId = sourceTask.taskId;
      const suppliedSourceContext = readStringArg(args, "source_context") ?? readStringArg(args, "sourceContext");
      const sourceContext = suppliedSourceContext ?? (sourceTaskId ? await sourceContextFromTask(sql, sourceTaskId) : null);
      if (!sourceContext) {
        return { success: false, message: "start_pipeline_run requires source_context when source_task_id is omitted" };
      }
      if (sourceTaskId) {
        const [existing] = await sql<{ id: string }[]>`
          SELECT id FROM pipeline_runs
          WHERE hive_id = ${hiveId}
            AND source_task_id = ${sourceTaskId}
            AND status = 'active'
          LIMIT 1
        `;
        if (existing) {
          return { success: false, message: `source task already has an active pipeline run: ${existing.id}` };
        }
      }
      const confidence = readNumberArg(args, "confidence");
      const handoff = [
        `Supervisor selected this pipeline for goal ${goalId}, sprint ${sprintNumber}.`,
        `selection_rationale: ${selectionRationale}`,
        confidence === null ? null : `confidence: ${confidence}`,
      ].filter(Boolean).join("\n");
      try {
        const result = await startPipelineRun(sql, {
          hiveId,
          templateId,
          sourceContext,
          sourceTaskId: sourceTaskId ?? undefined,
          goalId,
          sprintNumber: sprintNumber as number,
          supervisorHandoff: handoff,
        });
        return { success: true, message: `Pipeline run started: ${result.runId}`, data: result };
      } catch (error) {
        return { success: false, message: error instanceof Error ? error.message : "Failed to start pipeline run" };
      }
    }
    case "propose_pipeline_template": {
      const title = readStringArg(args, "title");
      const need = readStringArg(args, "need");
      const evidence = readStringArg(args, "evidence");
      if (!title) return { success: false, message: "propose_pipeline_template requires title" };
      if (!need) return { success: false, message: "propose_pipeline_template requires need" };
      if (!evidence) return { success: false, message: "propose_pipeline_template requires evidence" };
      const proposedSteps = Array.isArray(args.proposed_steps)
        ? args.proposed_steps.map(String)
        : Array.isArray(args.proposedSteps)
          ? args.proposedSteps.map(String)
          : [];
      const description = [
        "Design a reusable governed HiveWright pipeline template for this recurring work class.",
        "",
        `need: ${need}`,
        `evidence: ${evidence}`,
        `proposed_steps: ${JSON.stringify(proposedSteps)}`,
        "",
        "Governance path: propose the template, implement it inactive/research-mode first, dry-run it against evidence, then promote only after proof.",
      ].join("\n");
      const [sg] = await sql`
        INSERT INTO goals (hive_id, parent_id, title, description, status)
        VALUES (${hiveId}, ${goalId}, ${title}, ${description}, 'active')
        RETURNING id
      `;
      return { success: true, message: `Pipeline proposal sub-goal created: ${sg.id}`, data: { goalId: sg.id } };
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
      await recordAgentAuditEventBestEffort(sql, {
        eventType: AGENT_AUDIT_EVENTS.decisionCreated,
        actor: {
          type: "agent",
          id: "goal-supervisor",
          label: "goal-supervisor",
        },
        hiveId,
        goalId,
        taskId: sourceTaskId,
        targetType: "decision",
        targetId: d.id as string,
        outcome: "success",
        metadata: {
          source: "goals.supervisor_tools",
          toolName: "create_decision",
          decisionId: d.id,
          goalId,
          taskId: sourceTaskId,
          status,
          priority: args.priority ?? "normal",
          autoApproved: Boolean(args.auto_approve),
          optionCount: options?.length ?? null,
          contextProvided: Boolean(args.context),
          recommendationProvided: Boolean(args.recommendation),
        },
      });
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
      const learningGate = parseLearningGateResult(args.learning_gate ?? args.learningGate);
      if (!learningGate.ok) {
        return { success: false, message: `mark_goal_achieved rejected: ${learningGate.error}` };
      }
      const evidence = parseCompletionEvidenceBundle(args.evidence ?? args.evidenceBundle ?? args.evidence_bundle);
      if (!evidence.ok) {
        return { success: false, message: `mark_goal_achieved rejected: ${evidence.error}` };
      }
      const completionStatus = parseGoalCompletionStatus(args.completion_status ?? args.completionStatus);
      if ((args.completion_status ?? args.completionStatus) !== undefined && !completionStatus) {
        return { success: false, message: "mark_goal_achieved rejected: completion_status must be achieved, execution_ready, or blocked_on_owner_channel" };
      }
      const result = await completeGoal(sql, goalId, summary, {
        evidenceBundle: evidence.items,
        learningGate: learningGate.result,
        ...(completionStatus ? { completionStatus } : {}),
        auditActionKind: "mark_goal_achieved",
      });
      return { success: true, message: `Goal status set to ${result.status}` };
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

export async function rejectDirectContentTaskWhenPipelineFits(
  sql: Sql,
  hiveId: string,
  args: Record<string, unknown>,
  taskKind: string,
): Promise<ToolResult | null> {
  if (taskKind === "research" || taskKind === "planning" || taskKind === "decision") return null;

  const assignedTo = typeof args.assigned_to === "string" ? args.assigned_to : "";
  const text = [args.title, args.brief, args.acceptance_criteria]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
  const contentRole = new Set([
    "content-writer",
    "content-review-agent",
    "marketing-designer",
    "social-media-manager",
    "campaign-analyst",
    "image-designer",
    "frontend-designer",
  ]).has(assignedTo);
  const contentKeywords = /\b(copywriting|copy|landing page copy|landing-page copy|hero copy|cta|faq|metadata|publish handoff|newsletter|blog|social post|social media post|facebook ad|facbook ad|ad creative|advertisement|campaign creative|content package|draft|edit|publish|image asset|visual asset)\b/i.test(text);
  if (!contentRole && !contentKeywords) return null;

  const [template] = await sql<{ id: string; name: string }[]>`
    SELECT id, name
    FROM pipeline_templates
    WHERE slug = 'content-publishing'
      AND active = true
      AND (scope = 'global' OR hive_id = ${hiveId})
    ORDER BY version DESC
    LIMIT 1
  `;
  if (!template) return null;

  return {
    success: false,
    message: `create_task rejected: this looks like repeatable content/copywriting work and active pipeline '${template.name}' (slug='content-publishing') is available. Use list_pipeline_templates then start_pipeline_run with selection_rationale instead of creating direct execution tasks.`,
    data: { requiredPipelineSlug: "content-publishing", templateId: template.id },
  };
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

function readStringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumberArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

async function sourceContextFromTask(sql: Sql, taskId: string): Promise<string | null> {
  const [task] = await sql<{ title: string; brief: string | null; acceptance_criteria: string | null }[]>`
    SELECT title, brief, acceptance_criteria
    FROM tasks
    WHERE id = ${taskId}
  `;
  if (!task) return null;
  return [
    `title: ${task.title}`,
    task.brief ? `brief: ${task.brief}` : null,
    task.acceptance_criteria ? `acceptance_criteria: ${task.acceptance_criteria}` : null,
  ].filter(Boolean).join("\n");
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
