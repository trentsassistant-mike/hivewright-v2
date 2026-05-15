import type { Sql } from "postgres";
import {
  AGENT_AUDIT_EVENTS,
  recordAgentAuditEventBestEffort,
  type AgentAuditActor,
} from "../audit/agent-events";
import { sendNotification } from "../notifications/sender";
import { pruneGoalSupervisor } from "../openclaw/goal-supervisor-cleanup";
import { verifyLandedState } from "../software-pipeline/landed-state-gate";
import {
  DEFAULT_LEARNING_GATE_RESULT,
  type LearningGateResult,
} from "./outcome-records";
import { createLearningGateFollowup } from "./learning-gate-followup";

export type GoalCompletionStatus = "achieved" | "execution_ready" | "blocked_on_owner_channel";

export interface CompletionEvidenceItem {
  type: string;
  description: string;
  reference?: string;
  value?: unknown;
  verified?: boolean;
  status?: string;
}

const COMPLETION_STATUSES: readonly GoalCompletionStatus[] = ["achieved", "execution_ready", "blocked_on_owner_channel"];

export function parseGoalCompletionStatus(value: unknown): GoalCompletionStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((COMPLETION_STATUSES as readonly string[]).includes(normalized)) return normalized as GoalCompletionStatus;
  if (["ready", "ready_to_execute", "ready_to_send", "staged", "queued", "not_sent"].includes(normalized)) return "execution_ready";
  if (["awaiting_owner", "awaiting_owner_channel", "owner_channel_required", "manual_send_required", "owner_blocked"].includes(normalized)) {
    return "blocked_on_owner_channel";
  }
  return null;
}

export function parseCompletionEvidenceBundle(value: unknown):
  | { ok: true; items: CompletionEvidenceItem[] }
  | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: "evidence must be a non-empty array" };
  }

  const items: CompletionEvidenceItem[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: `evidence[${index}] must be an object` };
    }
    const record = raw as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    if (!type) return { ok: false, error: `evidence[${index}].type must be a non-empty string` };
    if (!description) return { ok: false, error: `evidence[${index}].description must be a non-empty string` };

    const reference = typeof record.reference === "string" && record.reference.trim()
      ? record.reference.trim()
      : undefined;
    const hasValue = record.value !== undefined && record.value !== null &&
      (typeof record.value !== "string" || record.value.trim().length > 0);
    if (!reference && !hasValue) {
      return { ok: false, error: `evidence[${index}] must include a non-empty reference or value` };
    }

    const item: CompletionEvidenceItem = { type, description };
    if (reference) item.reference = reference;
    if (hasValue) item.value = typeof record.value === "string" ? record.value.trim() : record.value;
    if (typeof record.verified === "boolean") item.verified = record.verified;
    if (typeof record.status === "string" && record.status.trim()) item.status = record.status.trim();
    items.push(item);
  }

  return { ok: true, items };
}

export interface CompleteGoalOptions {
  /** Who initiated the completion. Defaults to 'goal-supervisor'. */
  createdBy?: string;
  /** Task IDs that constitute evidence the success criteria were met. */
  evidenceTaskIds?: string[];
  /** Work product IDs that constitute evidence. */
  evidenceWorkProductIds?: string[];
  /** Lightweight proof bundle for artifact paths/URLs, test output, reviews, screenshots, or decisions. */
  evidenceBundle?: CompletionEvidenceItem[];
  /** Lightweight learning gate decision recorded at completion. */
  learningGate?: LearningGateResult;
  /** Structured final status. Defaults to achieved unless evidence explicitly carries a status. */
  completionStatus?: GoalCompletionStatus;
  /** Sanitized audit action label for the hive-memory write. */
  auditActionKind?: string;
}

export interface CompleteGoalResult {
  status: GoalCompletionStatus;
  completed: boolean;
}

function statusFromEvidence(evidenceBundle: CompletionEvidenceItem[] | undefined): GoalCompletionStatus | null {
  for (const item of evidenceBundle ?? []) {
    const parsed = parseGoalCompletionStatus(item.status);
    if (parsed) return parsed;
  }
  return null;
}

function auditActor(createdBy: string): AgentAuditActor {
  if (createdBy === "owner") return { type: "owner", id: createdBy, label: createdBy };
  if (createdBy === "system") return { type: "system", id: createdBy, label: createdBy };
  return { type: "agent", id: createdBy, label: createdBy };
}

export async function completeGoal(
  sql: Sql,
  goalId: string,
  completionSummary: string,
  options: CompleteGoalOptions = {},
): Promise<CompleteGoalResult> {
  const [goalContext] = await sql<{ project_id: string | null; project_git_repo: boolean | null }[]>`
    SELECT goals.project_id, projects.git_repo AS project_git_repo
    FROM goals
    LEFT JOIN projects ON projects.id = goals.project_id
    WHERE goals.id = ${goalId}
  `;
  if (!goalContext) {
    throw new Error(`Goal not found: ${goalId}`);
  }

  if (goalContext.project_git_repo === true) {
    const landed = await verifyLandedState();
    if (!landed.ok) {
      throw new Error(`Goal completion blocked: ${landed.failures.join(", ")}`);
    }
  }

  const createdBy = options.createdBy ?? "goal-supervisor";
  // Evidence policy: keys are present ONLY when their array is non-empty.
  // A no-evidence completion writes `{}` to the jsonb column (not
  // `{ taskIds: [], workProductIds: [] }`). Downstream readers (the
  // POST /api/goals/[id]/complete idempotency response, dashboard views)
  // must treat missing keys and empty arrays as semantically equivalent.
  const evidence: {
    taskIds?: string[];
    workProductIds?: string[];
    bundle?: CompletionEvidenceItem[];
  } = {};
  if (options.evidenceTaskIds && options.evidenceTaskIds.length > 0) {
    evidence.taskIds = options.evidenceTaskIds;
  }
  if (options.evidenceWorkProductIds && options.evidenceWorkProductIds.length > 0) {
    evidence.workProductIds = options.evidenceWorkProductIds;
  }
  if (options.evidenceBundle && options.evidenceBundle.length > 0) {
    evidence.bundle = options.evidenceBundle;
  }
  const learningGate = options.learningGate ?? DEFAULT_LEARNING_GATE_RESULT;
  const requestedStatus = options.completionStatus ?? statusFromEvidence(options.evidenceBundle) ?? "achieved";

  const completion = await sql.begin(async (tx) => {
    const [goal] = await tx<{ hive_id: string; title: string; status: string }[]>`
      SELECT hive_id, title, status
      FROM goals
      WHERE id = ${goalId}
      FOR UPDATE
    `;
    if (!goal) throw new Error(`Goal not found: ${goalId}`);
    if (goal.status === "achieved" || goal.status === "execution_ready" || goal.status === "blocked_on_owner_channel") {
      return {
        completed: false,
        hiveId: goal.hive_id,
        title: goal.title,
        status: goal.status as CompleteGoalResult["status"],
      };
    }
    if (goal.status !== "active") {
      throw new Error(`Goal cannot be completed: current status is '${goal.status}'`);
    }

    // 1. Mark final/next-action state and clear session. "execution_ready" and
    // "blocked_on_owner_channel" are intentional non-achieved end states: the
    // agents produced the package, but a human/channel action still gates the
    // real outcome.
    await tx`
      UPDATE goals SET status = ${requestedStatus}, session_id = NULL, updated_at = NOW()
      WHERE id = ${goalId}
        AND status = 'active'
    `;

    // 1b. Cascade-cancel every non-terminal task that transitively belongs to
    // this goal (direct children + their doctor / QA / replan descendants via
    // parent_task_id). A goal being marked achieved by the supervisor means
    // the underlying failures are no longer actionable — leaving them as
    // 'failed' or 'unresolvable' pollutes the owner-brief counters (e.g. the
    // "N unresolvable tasks." banner). Terminal statuses (completed,
    // cancelled, superseded) are preserved so history is honest; only stuck
    // non-terminal ones are closed out.
    await tx`
      WITH RECURSIVE goal_task_tree AS (
        SELECT id, status FROM tasks WHERE goal_id = ${goalId}
        UNION
        SELECT t.id, t.status FROM tasks t
        JOIN goal_task_tree gt ON t.parent_task_id = gt.id
      )
      UPDATE tasks
      SET status = 'cancelled',
          result_summary = CASE
            WHEN result_summary IS NULL OR result_summary = ''
              THEN 'Cancelled by goal completion (parent goal marked achieved)'
            WHEN result_summary LIKE '%Cancelled by goal completion (parent goal marked achieved)%'
              THEN result_summary
            ELSE result_summary || E'\n[Cancelled by goal completion (parent goal marked achieved)]'
          END,
          failure_reason = NULL,
          updated_at = NOW()
      WHERE id IN (
        SELECT id FROM goal_task_tree
        WHERE status NOT IN ('completed', 'cancelled', 'superseded')
      )
    `;

    // 2. Write completion summary to hive memory
    const memorySummary = requestedStatus === "achieved"
      ? `Goal "${goal.title}" achieved: ${completionSummary}`
      : `Goal "${goal.title}" status ${requestedStatus}: ${completionSummary}`;
    const [memory] = await tx<{ id: string }[]>`
      INSERT INTO hive_memory (hive_id, category, content, confidence, sensitivity)
      VALUES (${goal.hive_id}, 'general', ${memorySummary}, 1.0, 'internal')
      RETURNING id
    `;
    await recordAgentAuditEventBestEffort(tx as unknown as Sql, {
      eventType: AGENT_AUDIT_EVENTS.hiveMemoryWritten,
      actor: auditActor(createdBy),
      hiveId: goal.hive_id,
      goalId,
      targetType: "hive_memory",
      targetId: memory.id,
      outcome: "success",
      metadata: {
        source: "goals.complete_goal",
        actionKind: options.auditActionKind ?? "complete_goal",
        memoryId: memory.id,
        goalId,
        category: "general",
        sensitivity: "internal",
        evidenceTaskCount: evidence.taskIds?.length ?? 0,
        evidenceWorkProductCount: evidence.workProductIds?.length ?? 0,
        evidenceBundleCount: evidence.bundle?.length ?? 0,
        completionStatus: requestedStatus,
      },
    });

    // 3. Write audit row to goal_completions
    await tx`
      INSERT INTO goal_completions (goal_id, summary, evidence, learning_gate, created_by)
      VALUES (
        ${goalId},
        ${completionSummary},
        ${tx.json(evidence as unknown as Parameters<typeof tx.json>[0])},
        ${tx.json(learningGate as unknown as Parameters<typeof tx.json>[0])},
        ${createdBy}
      )
    `;

    await createLearningGateFollowup(tx as unknown as Sql, {
      goalId,
      hiveId: goal.hive_id,
      goalTitle: goal.title,
      completionSummary,
      learningGate,
    });

    return {
      completed: true,
      hiveId: goal.hive_id,
      title: goal.title,
      status: requestedStatus,
    };
  });

  if (!completion.completed) {
    return { completed: false, status: completion.status };
  }

  // 3b. Prune the goal-supervisor entry from ~/.openclaw/ after DB commit.
  try {
    await pruneGoalSupervisor(sql, goalId);
  } catch (error) {
    console.warn(
      `[completeGoal] failed to prune supervisor for goal ${goalId}:`,
      error instanceof Error ? error.message : error,
    );
  }

  // 4. External notification after DB commit.
  try {
    await sendNotification(sql, {
    // postgres-js returns untyped rows; hive_id is uuid NOT NULL per schema.
    hiveId: completion.hiveId,
    title: `Goal status ${completion.status}: ${completion.title}`,
    message: completionSummary,
    priority: "normal",
    source: "goal-completion",
    });
  } catch (error) {
    console.warn(
      `[completeGoal] failed to send completion notification for goal ${goalId}:`,
      error instanceof Error ? error.message : error,
    );
  }

  return { completed: true, status: completion.status };
}
