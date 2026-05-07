import type { Sql } from "postgres";
import type {
  ApplySupervisorActionsContext,
  AppliedOutcome,
  SupervisorAction,
  SupervisorActions,
} from "./types";

/**
 * Deterministic applier for supervisor actions. Mirrors the doctor
 * applyDoctorDiagnosis pattern: each branch is small, side-effects are
 * captured in an AppliedOutcome per action, and individual failures do
 * NOT abort the batch (wrap per-action in try/catch so one bad taskId
 * can't block the other nine findings from being addressed).
 *
 * **Governance contract (do not weaken):** every `create_decision` action
 * — regardless of tier — inserts with `status='ea_review'`. Owner-facing
 * decisions must flow through the EA first; the EA attempts autonomous
 * resolution and only promotes a decision to `pending` (owner-visible)
 * when it genuinely needs the owner's input. See the
 * `decisions_via_ea_first` feedback memory. A stray `pending` insert on
 * the supervisor path would bypass the EA buffer and page the owner
 * directly — a regression we test against explicitly.
 *
 * **Safety caps (non-loop guarantee):**
 *   1. Max 5 `spawn_followup` per heartbeat — 6th+ skipped.
 *   2. Skip a `spawn_followup` whose (hive_id, assignedTo, title) matches
 *      either a prior supervisor_reports action or an already-created
 *      hive-supervisor task from the last 24h. The task-row check is the
 *      retry guard for partial finalization: if side effects were written
 *      but the report update failed, the next finalization pass will not
 *      duplicate the spawned work.
 *   3. Skip a `create_decision` whose exact EA-review payload already
 *      materialized in the last 24h. Hive Supervisor talks to the EA, and
 *      repeated heartbeats must not flood the EA review queue either.
 */

const MAX_SPAWNS_PER_HEARTBEAT = 5;
const MAX_ACTION_TITLE_LENGTH = 200;
const MAX_FOLLOWUP_BRIEF_LENGTH = 4_000;
const MAX_ACTION_NOTE_LENGTH = 2_000;
const MAX_DECISION_CONTEXT_LENGTH = 4_000;
const MAX_DECISION_RECOMMENDATION_LENGTH = 2_000;
const MAX_DECISION_OPTION_TEXT_LENGTH = 1_000;
const MAX_INSIGHT_CATEGORY_LENGTH = 80;
const MAX_INSIGHT_CONTENT_LENGTH = 4_000;

const TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "cancelled",
  "superseded",
  "unresolvable",
]);

type SpawnKey = { assignedTo: string; title: string };

export async function applySupervisorActions(
  sql: Sql,
  hiveId: string,
  actions: SupervisorActions,
  context: ApplySupervisorActionsContext = {},
): Promise<AppliedOutcome[]> {
  const priorSpawns = await loadDedupeSet(sql, hiveId);
  const blockedWakeGoals = extractBlockedWakeGoals(context.report);
  const outcomes: AppliedOutcome[] = [];
  let spawnsApplied = 0;

  for (const action of actions.actions) {
    if (action.kind === "spawn_followup") {
      if (spawnsApplied >= MAX_SPAWNS_PER_HEARTBEAT) {
        outcomes.push({
          action,
          status: "skipped",
          detail: `spawn cap reached (${MAX_SPAWNS_PER_HEARTBEAT}) — skipping remaining follow-ups this heartbeat.`,
        });
        continue;
      }
      const key = spawnKey(action.assignedTo, action.title);
      if (priorSpawns.has(key)) {
        outcomes.push({
          action,
          status: "skipped",
          detail: `duplicate follow-up skipped (same assignedTo+title spawned within the last 24h dedupe window).`,
        });
        continue;
      }
    }

    try {
      const validationSkip = await validateActionBounds(sql, hiveId, action);
      if (validationSkip) {
        outcomes.push({
          action,
          status: "skipped",
          detail: validationSkip,
        });
        continue;
      }

      if (
        action.kind === "create_decision" &&
        await hasDuplicateEaDecision(sql, hiveId, action)
      ) {
        outcomes.push({
          action,
          status: "skipped",
          detail:
            "duplicate EA review item skipped (same decision payload in the last 24h dedupe window).",
        });
        continue;
      }

      if (action.kind === "wake_goal") {
        const blockedRunId = blockedWakeGoals.get(action.goalId);
        if (blockedRunId) {
          const isBlocked = await hasSameRunPerRunCapSuppression(sql, {
            hiveId,
            goalId: action.goalId,
            runId: blockedRunId,
          });
          if (isBlocked) {
            console.info("[supervisor] wake_goal skipped by same-run suppression", {
              goalId: action.goalId,
              runId: blockedRunId,
              suppressionReason: "per_run_cap",
            });
            outcomes.push({
              action,
              status: "skipped",
              detail:
                `wake_goal skipped: goal ${action.goalId} was suppressed in initiative run ` +
                `${blockedRunId} with suppression_reason=per_run_cap.`,
            });
            continue;
          }
        }
      }

      const detail = await applyOne(sql, hiveId, action);
      outcomes.push({ action, status: "applied", detail });
      if (action.kind === "spawn_followup") {
        spawnsApplied += 1;
        priorSpawns.add(spawnKey(action.assignedTo, action.title));
      }
    } catch (err) {
      outcomes.push({
        action,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return outcomes;
}

async function applyOne(
  sql: Sql,
  hiveId: string,
  action: SupervisorAction,
): Promise<string> {
  switch (action.kind) {
    case "noop":
      return `noop: ${action.reasoning}`;

    case "spawn_followup": {
      const [parent] = await sql<{ hive_id: string; project_id: string | null }[]>`
        SELECT hive_id, project_id FROM tasks WHERE id = ${action.originalTaskId}
      `;
      if (!parent) {
        throw new Error(
          `spawn_followup: parent task ${action.originalTaskId} not found`,
        );
      }
      if (parent.hive_id !== hiveId) {
        throw new Error(
          `spawn_followup: parent task ${action.originalTaskId} belongs to a different hive`,
        );
      }
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO tasks (
          hive_id, assigned_to, created_by, status, title, brief,
          parent_task_id, qa_required, project_id
        )
        VALUES (
          ${hiveId}, ${action.assignedTo}, 'hive-supervisor', 'pending',
          ${action.title}, ${action.brief},
          ${action.originalTaskId}, ${action.qaRequired ?? false}, ${parent.project_id}
        )
        RETURNING id
      `;
      return `spawn_followup: created task ${row.id} assigned to ${action.assignedTo}`;
    }

    case "wake_goal": {
      // Roll last_woken_sprint back to 0 so the dispatcher's goal-lifecycle
      // poll re-detects this goal as needing a wake-up on its next pass.
      // This is the same "mark before wake" marker used in
      // src/dispatcher/goal-lifecycle.ts — we intentionally reuse the
      // existing wake mechanism rather than inventing a new signal.
      const result = await sql`
        UPDATE goals
        SET last_woken_sprint = 0, updated_at = NOW()
        WHERE id = ${action.goalId} AND hive_id = ${hiveId}
      `;
      if ((result.count ?? 0) === 0) {
        throw new Error(
          `wake_goal: goal ${action.goalId} not found in hive ${hiveId}`,
        );
      }
      return `wake_goal: ${action.goalId} — ${action.reasoning}`;
    }

    case "create_decision": {
      // Governance-critical: both tier 2 and tier 3 route through the EA.
      // Owner is a USER, not a developer; the EA buffer attempts
      // autonomous resolution before any owner notification fires.
      const priority = decisionPriority(action);
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO decisions (
          hive_id, title, context, recommendation, options, priority, status, kind
        )
        VALUES (
          ${hiveId},
          ${action.title},
          ${action.context},
          ${action.recommendation ?? null},
          ${action.options === undefined ? null : sql.json(action.options as unknown as Parameters<typeof sql.json>[0])},
          ${priority},
          'ea_review',
          'supervisor_flagged'
        )
        RETURNING id
      `;
      return `create_decision(tier=${action.tier}): ${row.id} → ea_review`;
    }

    case "close_task": {
      const result = await sql`
        UPDATE tasks
        SET status = 'completed',
            result_summary = COALESCE(result_summary || E'\n\n' || ${"[hive-supervisor] " + action.note}, ${"[hive-supervisor] " + action.note}),
            completed_at = COALESCE(completed_at, NOW()),
            updated_at = NOW(),
            failure_reason = NULL
        WHERE id = ${action.taskId} AND hive_id = ${hiveId}
      `;
      if ((result.count ?? 0) === 0) {
        throw new Error(
          `close_task: task ${action.taskId} not found in hive ${hiveId}`,
        );
      }
      return `close_task: ${action.taskId}`;
    }

    case "mark_unresolvable": {
      const result = await sql`
        UPDATE tasks
        SET status = 'unresolvable',
            failure_reason = ${action.reason},
            updated_at = NOW()
        WHERE id = ${action.taskId} AND hive_id = ${hiveId}
      `;
      if ((result.count ?? 0) === 0) {
        throw new Error(
          `mark_unresolvable: task ${action.taskId} not found in hive ${hiveId}`,
        );
      }
      return `mark_unresolvable: ${action.taskId}`;
    }

    case "log_insight": {
      await sql`
        INSERT INTO hive_memory (hive_id, category, content, sensitivity)
        VALUES (${hiveId}, ${action.category}, ${action.content}, 'internal')
      `;
      return `log_insight(${action.category}): logged to hive_memory`;
    }
  }
}

async function validateActionBounds(
  sql: Sql,
  hiveId: string,
  action: SupervisorAction,
): Promise<string | null> {
  switch (action.kind) {
    case "noop":
      return boundedText("noop.reasoning", action.reasoning, MAX_ACTION_NOTE_LENGTH);

    case "spawn_followup": {
      const titleSkip = boundedText("spawn_followup.title", action.title, MAX_ACTION_TITLE_LENGTH);
      if (titleSkip) return titleSkip;
      const briefSkip = boundedText("spawn_followup.brief", action.brief, MAX_FOLLOWUP_BRIEF_LENGTH);
      if (briefSkip) return briefSkip;

      const [role] = await sql<{ slug: string }[]>`
        SELECT slug FROM role_templates WHERE slug = ${action.assignedTo}
      `;
      if (!role) {
        return `spawn_followup skipped: assignedTo role ${action.assignedTo} does not exist.`;
      }
      return null;
    }

    case "wake_goal": {
      const reasoningSkip = boundedText("wake_goal.reasoning", action.reasoning, MAX_ACTION_NOTE_LENGTH);
      if (reasoningSkip) return reasoningSkip;

      const [goal] = await sql<{ status: string }[]>`
        SELECT status FROM goals WHERE id = ${action.goalId} AND hive_id = ${hiveId}
      `;
      if (!goal) return null;
      if (goal.status !== "active") {
        return `wake_goal skipped: goal ${action.goalId} has status=${goal.status}; only active goals can be woken.`;
      }
      return null;
    }

    case "create_decision": {
      const titleSkip = boundedText("create_decision.title", action.title, MAX_ACTION_TITLE_LENGTH);
      if (titleSkip) return titleSkip;
      const contextSkip = boundedText("create_decision.context", action.context, MAX_DECISION_CONTEXT_LENGTH);
      if (contextSkip) return contextSkip;
      if (action.recommendation) {
        const recommendationSkip = boundedText(
          "create_decision.recommendation",
          action.recommendation,
          MAX_DECISION_RECOMMENDATION_LENGTH,
        );
        if (recommendationSkip) return recommendationSkip;
      }
      for (const [index, option] of (action.options ?? []).entries()) {
        for (const [field, value] of Object.entries(option)) {
          if (typeof value !== "string") continue;
          const optionSkip = boundedText(
            `create_decision.options[${index}].${field}`,
            value,
            MAX_DECISION_OPTION_TEXT_LENGTH,
          );
          if (optionSkip) return optionSkip;
        }
      }
      return null;
    }

    case "close_task": {
      const noteSkip = boundedText("close_task.note", action.note, MAX_ACTION_NOTE_LENGTH);
      if (noteSkip) return noteSkip;
      return validateMutableTask(sql, hiveId, action.taskId, "close_task");
    }

    case "mark_unresolvable": {
      const reasonSkip = boundedText("mark_unresolvable.reason", action.reason, MAX_ACTION_NOTE_LENGTH);
      if (reasonSkip) return reasonSkip;
      return validateMutableTask(sql, hiveId, action.taskId, "mark_unresolvable");
    }

    case "log_insight": {
      const categorySkip = boundedText("log_insight.category", action.category, MAX_INSIGHT_CATEGORY_LENGTH);
      if (categorySkip) return categorySkip;
      return boundedText("log_insight.content", action.content, MAX_INSIGHT_CONTENT_LENGTH);
    }
  }
}

async function validateMutableTask(
  sql: Sql,
  hiveId: string,
  taskId: string,
  actionKind: "close_task" | "mark_unresolvable",
): Promise<string | null> {
  const [task] = await sql<{ status: string }[]>`
    SELECT status FROM tasks WHERE id = ${taskId} AND hive_id = ${hiveId}
  `;
  if (!task) return null;
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return `${actionKind} skipped: task ${taskId} is terminal with status=${task.status}.`;
  }
  return null;
}

function boundedText(field: string, value: string, maxLength: number): string | null {
  if (value.length <= maxLength) return null;
  return `${field} skipped: bounded text too long (${value.length}/${maxLength}).`;
}

function decisionPriority(
  action: Extract<SupervisorAction, { kind: "create_decision" }>,
): string {
  return action.tier === 3 ? "urgent" : "high";
}

async function hasDuplicateEaDecision(
  sql: Sql,
  hiveId: string,
  action: Extract<SupervisorAction, { kind: "create_decision" }>,
): Promise<boolean> {
  const optionsJson = action.options === undefined
    ? null
    : action.options as unknown as Parameters<typeof sql.json>[0];
  const [row] = await sql<{ id: string }[]>`
    SELECT id
    FROM decisions
    WHERE hive_id = ${hiveId}
      AND kind = 'supervisor_flagged'
      AND created_at > NOW() - interval '24 hours'
      AND title = ${action.title}
      AND context = ${action.context}
      AND COALESCE(recommendation, '') = ${action.recommendation ?? ""}
      AND priority = ${decisionPriority(action)}
      AND COALESCE(options, 'null'::jsonb) = ${sql.json(optionsJson)}::jsonb
    LIMIT 1
  `;
  return Boolean(row);
}

/**
 * Loads the (assignedTo, title) pairs from every spawn_followup action
 * recorded in any supervisor_reports row for this hive in the last 24h,
 * plus task rows that already materialized from hive-supervisor in the
 * same window. The task-row arm is what makes retry after a partial
 * apply/persist failure idempotent.
 */
async function loadDedupeSet(
  sql: Sql,
  hiveId: string,
): Promise<Set<string>> {
  const rows = await sql<
    Array<{ assigned_to: string; title: string }>
  >`
    SELECT a->>'assignedTo' AS assigned_to,
           a->>'title'      AS title
    FROM supervisor_reports r,
         jsonb_array_elements(r.actions->'actions') a
    WHERE r.hive_id = ${hiveId}
      AND r.ran_at > NOW() - interval '24 hours'
      AND a->>'kind' = 'spawn_followup'
      AND a ? 'assignedTo'
      AND a ? 'title'
  `;
  const set = new Set<string>();
  for (const r of rows) {
    if (r.assigned_to && r.title) set.add(spawnKey(r.assigned_to, r.title));
  }

  const taskRows = await sql<
    Array<{ assigned_to: string; title: string }>
  >`
    SELECT assigned_to, title
    FROM tasks
    WHERE hive_id = ${hiveId}
      AND created_by = 'hive-supervisor'
      AND created_at > NOW() - interval '24 hours'
      AND assigned_to IS NOT NULL
      AND title IS NOT NULL
  `;
  for (const r of taskRows) {
    if (r.assigned_to && r.title) set.add(spawnKey(r.assigned_to, r.title));
  }

  return set;
}

function spawnKey(assignedTo: string, title: string): string {
  return `${assignedTo}::${title}`;
}

function extractBlockedWakeGoals(
  report: ApplySupervisorActionsContext["report"],
): Map<string, string> {
  const blocked = new Map<string, string>();
  if (!report) return blocked;

  for (const finding of report.findings) {
    if (finding.kind !== "dormant_goal" || !finding.ref.goalId) {
      continue;
    }
    const detail = finding.detail as Record<string, unknown>;
    const initiative = detail.initiative as Record<string, unknown> | undefined;
    if (!initiative) continue;
    const latestSuppression = initiative.latestSuppression as Record<string, unknown> | undefined;
    if (!latestSuppression) continue;
    const runId = latestSuppression.runId;
    const suppressionReason = latestSuppression.suppressionReason;
    if (typeof runId === "string" && suppressionReason === "per_run_cap") {
      blocked.set(finding.ref.goalId, runId);
    }
  }

  return blocked;
}

async function hasSameRunPerRunCapSuppression(
  sql: Sql,
  input: { hiveId: string; goalId: string; runId: string },
): Promise<boolean> {
  const [row] = await sql<Array<{ id: string }>>`
    SELECT id
    FROM initiative_run_decisions
    WHERE hive_id = ${input.hiveId}
      AND run_id = ${input.runId}
      AND candidate_ref = ${input.goalId}
      AND suppression_reason = 'per_run_cap'
    LIMIT 1
  `;
  return Boolean(row);
}

// Type-only import preservation for downstream consumers that only need
// the kind/key helpers — Vitest's module graph complains if an imported
// symbol is unused in the compiled output but referenced in comments.
export type { SpawnKey };
