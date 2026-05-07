import type { Sql } from "postgres";
import { buildInternalServiceAuthorizationHeader } from "@/lib/internal-service-auth";
import {
  countCreatedInitiativeActionsSince,
  countCreatedInitiativeActionsToday,
  createInitiativeRun,
  finalizeInitiativeRun,
  findRecentCreatedDecisionByDedupeKey,
  recordInitiativeDecision,
  type InitiativeActionTaken,
} from "./store";
import { evaluateInitiativeCreationPolicy } from "./policy";
import {
  DORMANT_GOAL_MIN_AGE_HOURS,
  INITIATIVE_COOLDOWN_HOURS,
  MAX_CREATED_TASKS_PER_DAY,
  MAX_CREATED_TASKS_PER_HOUR,
  MAX_CREATED_TASKS_PER_RUN,
  MAX_OPEN_TASKS_BEFORE_SUPPRESS,
} from "./constants";

export interface InitiativeTrigger {
  kind: "schedule";
  scheduleId?: string | null;
  targetGoalId?: string | null;
}

export interface InitiativeCandidateOutcome {
  decisionId: string;
  goalId: string;
  candidateKey: string;
  dedupeKey: string;
  actionTaken: InitiativeActionTaken;
  suppressionReason?: string | null;
  rationale: string;
  createdGoalId?: string | null;
  createdTaskId?: string | null;
  evidence: unknown;
}

export interface InitiativeRunResult {
  runId: string;
  trigger: InitiativeTrigger;
  candidatesEvaluated: number;
  tasksCreated: number;
  suppressed: number;
  noop: number;
  errored: number;
  outcomes: InitiativeCandidateOutcome[];
}

interface DormantGoalCandidate {
  goalId: string;
  projectId: string | null;
  goalTitle: string;
  goalDescription: string | null;
  lastGoalProgressAt: Date;
  hoursSinceGoalProgress: number | string;
}

interface ScopedDormantGoalContext {
  targetGoalId: string;
  targetGoalTitle: string | null;
  alternateDormantGoalCount: number;
}

interface HiveQueueMetrics {
  openTasks: number;
  pendingDecisions: number;
}

export interface InitiativeWorkSubmission {
  hiveId: string;
  input: string;
  projectId?: string | null;
  goalId?: string | null;
  priority: number;
  acceptanceCriteria: string;
}

export interface RunInitiativeEvaluationOptions {
  submitWork?: (
    input: InitiativeWorkSubmission,
  ) => Promise<{ id: string; type: "task" | "goal"; title: string; classification: unknown }>;
}

export async function runInitiativeEvaluation(
  sql: Sql,
  input: { hiveId: string; trigger: InitiativeTrigger },
  options: RunInitiativeEvaluationOptions = {},
): Promise<InitiativeRunResult> {
  const triggerType = input.trigger.kind;
  const submitWork = options.submitWork ?? submitInitiativeWorkViaApi;
  const scopedDormantGoalContext = input.trigger.targetGoalId
    ? await loadScopedDormantGoalContext(sql, input.hiveId, input.trigger.targetGoalId)
    : null;
  const run = await createInitiativeRun(sql, {
    hiveId: input.hiveId,
    trigger: {
      type: triggerType,
      ref: input.trigger.scheduleId ?? null,
    },
    guardrailConfig: {
      cooldownHours: INITIATIVE_COOLDOWN_HOURS,
      perRunCap: MAX_CREATED_TASKS_PER_RUN,
      perDayCap: MAX_CREATED_TASKS_PER_DAY,
      perHourCap: MAX_CREATED_TASKS_PER_HOUR,
      targetGoalId: input.trigger.targetGoalId ?? null,
      targetGoalScope: scopedDormantGoalContext ? "single_goal" : null,
      targetGoalTitle: scopedDormantGoalContext?.targetGoalTitle ?? null,
      excludedAlternateDormantGoalCount: scopedDormantGoalContext?.alternateDormantGoalCount ?? null,
      maxOpenTasksBeforeSuppress: MAX_OPEN_TASKS_BEFORE_SUPPRESS,
    },
  });

  if (scopedDormantGoalContext) {
    console.info("[initiative-run] scoped dormant-goal evaluation", {
      hiveId: input.hiveId,
      runId: run.id,
      targetGoalId: scopedDormantGoalContext.targetGoalId,
      targetGoalTitle: scopedDormantGoalContext.targetGoalTitle,
      excludedAlternateDormantGoalCount: scopedDormantGoalContext.alternateDormantGoalCount,
    });
  }

  try {
    const candidates = await findDormantGoalCandidates(
      sql,
      input.hiveId,
      input.trigger.targetGoalId ?? null,
    );
    const metrics = await fetchHiveQueueMetrics(sql, input.hiveId);

    let openTasks = metrics.openTasks;
    let createdThisRun = 0;
    let createdToday = await countCreatedInitiativeActionsToday(sql, input.hiveId);
    let createdThisHour = await countCreatedInitiativeActionsSince(sql, {
      hiveId: input.hiveId,
      hours: 1,
    });
    const outcomes: InitiativeCandidateOutcome[] = [];

    for (const candidate of candidates) {
      const candidateKey = `dormant-goal-next-task:${candidate.goalId}`;
      const dedupeKey = candidateKey;
      const hoursSinceGoalProgress = Number(candidate.hoursSinceGoalProgress);
      const evidenceBase = {
        trigger: input.trigger,
        candidate: {
          kind: "dormant-goal-next-task",
          goalId: candidate.goalId,
          goalTitle: candidate.goalTitle,
          lastGoalProgressAt: candidate.lastGoalProgressAt,
          hoursSinceGoalProgress: Number(hoursSinceGoalProgress.toFixed(2)),
        },
        hive: {
          openTasksBeforeCandidate: openTasks,
          pendingDecisions: metrics.pendingDecisions,
          createdThisRun,
          createdToday,
          createdThisHour,
        },
        scope: scopedDormantGoalContext
          ? {
              mode: "single_goal",
              targetGoalId: scopedDormantGoalContext.targetGoalId,
              targetGoalTitle: scopedDormantGoalContext.targetGoalTitle,
              targetFrozen: true,
              excludedAlternateDormantGoalCount:
                scopedDormantGoalContext.alternateDormantGoalCount,
            }
          : {
              mode: "full_hive_scan",
            },
      };

      const openTask = await findExistingOpenGoalTask(sql, candidate.goalId);
      if (openTask) {
        outcomes.push(await persistDecision(sql, {
          runId: run.id,
          hiveId: input.hiveId,
          triggerType,
          goalId: candidate.goalId,
          candidateKey,
          dedupeKey,
          actionTaken: "suppress",
          suppressionReason:
            openTask.createdBy === "initiative-engine"
              ? "duplicate_open_task"
              : "existing_goal_task",
          rationale:
            openTask.createdBy === "initiative-engine"
              ? `Suppressed initiative follow-up for "${candidate.goalTitle}" because an open initiative task already exists.`
              : `Suppressed initiative follow-up for "${candidate.goalTitle}" because the goal already has an open task.`,
          evidence: {
            ...evidenceBase,
            suppression: {
              reason:
                openTask.createdBy === "initiative-engine"
                  ? "duplicate_open_task"
                  : "existing_goal_task",
              taskId: openTask.id,
              taskStatus: openTask.status,
              createdBy: openTask.createdBy,
              assignedTo: openTask.assignedTo,
            },
          },
        }));
        continue;
      }

      const cooldown = await findRecentCreatedDecisionByDedupeKey(sql, {
        hiveId: input.hiveId,
        dedupeKey,
        cooldownHours: INITIATIVE_COOLDOWN_HOURS,
      });
      if (cooldown) {
        outcomes.push(await persistDecision(sql, {
          runId: run.id,
          hiveId: input.hiveId,
          triggerType,
          goalId: candidate.goalId,
          candidateKey,
          dedupeKey,
          actionTaken: "suppress",
          suppressionReason: "cooldown_active",
          rationale: `Suppressed initiative follow-up for "${candidate.goalTitle}" because the cooldown window is still active.`,
          evidence: {
            ...evidenceBase,
            suppression: {
              reason: "cooldown_active",
              priorDecisionId: cooldown.id,
              priorRunId: cooldown.run_id,
              priorCreatedTaskId: cooldown.created_task_id,
              priorCreatedAt: cooldown.created_at,
            },
          },
        }));
        continue;
      }

      if (openTasks >= MAX_OPEN_TASKS_BEFORE_SUPPRESS) {
        outcomes.push(await persistDecision(sql, {
          runId: run.id,
          hiveId: input.hiveId,
          triggerType,
          goalId: candidate.goalId,
          candidateKey,
          dedupeKey,
          actionTaken: "suppress",
          suppressionReason: "queue_saturated",
          rationale: `Suppressed initiative follow-up for "${candidate.goalTitle}" because the hive already has too much unresolved work.`,
          evidence: {
            ...evidenceBase,
            suppression: {
              reason: "queue_saturated",
              openTasks,
              threshold: MAX_OPEN_TASKS_BEFORE_SUPPRESS,
            },
          },
        }));
        continue;
      }

      if (createdThisRun >= MAX_CREATED_TASKS_PER_RUN) {
        outcomes.push(await persistDecision(sql, {
          runId: run.id,
          hiveId: input.hiveId,
          triggerType,
          goalId: candidate.goalId,
          candidateKey,
          dedupeKey,
          actionTaken: "suppress",
          suppressionReason: "per_run_cap",
          rationale: `Suppressed initiative follow-up for "${candidate.goalTitle}" because this run already created its maximum work item.`,
          evidence: {
            ...evidenceBase,
            suppression: {
              reason: "per_run_cap",
              createdThisRun,
              threshold: MAX_CREATED_TASKS_PER_RUN,
            },
          },
        }));
        continue;
      }

      if (createdToday >= MAX_CREATED_TASKS_PER_DAY) {
        outcomes.push(await persistDecision(sql, {
          runId: run.id,
          hiveId: input.hiveId,
          triggerType,
          goalId: candidate.goalId,
          candidateKey,
          dedupeKey,
          actionTaken: "suppress",
          suppressionReason: "per_day_cap",
          rationale: `Suppressed initiative follow-up for "${candidate.goalTitle}" because the hive already reached today's initiative creation cap.`,
          evidence: {
            ...evidenceBase,
            suppression: {
              reason: "per_day_cap",
              createdToday,
              threshold: MAX_CREATED_TASKS_PER_DAY,
            },
          },
        }));
        continue;
      }

      if (createdThisHour >= MAX_CREATED_TASKS_PER_HOUR) {
        outcomes.push(await persistDecision(sql, {
          runId: run.id,
          hiveId: input.hiveId,
          triggerType,
          goalId: candidate.goalId,
          candidateKey,
          dedupeKey,
          actionTaken: "suppress",
          suppressionReason: "rate_limited_global",
          rationale: `Suppressed initiative follow-up for "${candidate.goalTitle}" because the hive already reached the hourly initiative creation cap.`,
          evidence: {
            ...evidenceBase,
            suppression: {
              reason: "rate_limited_global",
              createdThisHour,
              threshold: MAX_CREATED_TASKS_PER_HOUR,
            },
          },
        }));
        continue;
      }

      const taskBrief = buildDormantGoalTaskBrief(candidate);
      const acceptanceCriteria =
        "A concrete next task exists on the dormant goal, with an explicit outcome and no duplicate follow-up spawned.";
      const policy = await evaluateInitiativeCreationPolicy({
        input: taskBrief,
        acceptanceCriteria,
      });
      if (!policy.allowed) {
        logInitiativePolicyBlock({
          hiveId: input.hiveId,
          goalId: candidate.goalId,
          candidateKey,
          decision: policy.decision,
          reason: policy.reason,
          rationale: policy.rationale,
          sensitivity: policy.sensitivity,
          escalationPath: policy.escalationPath,
        });
        outcomes.push(await persistDecision(sql, {
          runId: run.id,
          hiveId: input.hiveId,
          triggerType,
          goalId: candidate.goalId,
          candidateKey,
          dedupeKey,
          actionTaken: "suppress",
          suppressionReason: policy.reason,
          rationale: `Suppressed initiative follow-up for "${candidate.goalTitle}" because ${policy.rationale}`,
          evidence: {
            ...evidenceBase,
            policy,
            suppression: {
              reason: policy.reason,
              sensitivity: policy.sensitivity,
              escalationPath: policy.escalationPath,
            },
          },
        }));
        continue;
      }

      try {
        const work = await submitWork({
          hiveId: input.hiveId,
          input: taskBrief,
          projectId: candidate.projectId,
          goalId: candidate.goalId,
          priority: 4,
          acceptanceCriteria,
        });

        createdThisRun++;
        createdToday++;
        createdThisHour++;
        openTasks++;

        outcomes.push(await persistDecision(sql, {
          runId: run.id,
          hiveId: input.hiveId,
          triggerType,
          goalId: candidate.goalId,
          candidateKey,
          dedupeKey,
          actionTaken: work.type === "goal" ? "create_goal" : "create_task",
          rationale:
            work.type === "goal"
              ? `Created a follow-up goal for dormant goal "${candidate.goalTitle}".`
              : `Created a restart task for dormant goal "${candidate.goalTitle}".`,
          createdGoalId: work.type === "goal" ? work.id : null,
          createdTaskId: work.type === "task" ? work.id : null,
          actionPayload: {
            candidateGoalId: candidate.goalId,
            workItemId: work.id,
            workItemType: work.type,
            workItemTitle: work.title,
          },
          evidence: {
            ...evidenceBase,
            creation: {
              workItemId: work.id,
              workItemType: work.type,
              classification: work.classification,
            },
          },
        }));
      } catch (error) {
        outcomes.push(await persistDecision(sql, {
          runId: run.id,
          hiveId: input.hiveId,
          triggerType,
          goalId: candidate.goalId,
          candidateKey,
          dedupeKey,
          actionTaken: "noop",
          rationale: `Initiative follow-up failed for dormant goal "${candidate.goalTitle}".`,
          evidence: {
            ...evidenceBase,
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    }

    await finalizeInitiativeRun(sql, summarizeRun(run.id, outcomes));

    return {
      runId: run.id,
      trigger: input.trigger,
      candidatesEvaluated: outcomes.length,
      tasksCreated: outcomes.filter((outcome) => outcome.actionTaken === "create_task").length,
      suppressed: outcomes.filter((outcome) => outcome.actionTaken === "suppress").length,
      noop: outcomes.filter((outcome) => outcome.actionTaken === "noop").length,
      errored: outcomes.filter((outcome) => outcome.actionTaken === "noop").length,
      outcomes,
    };
  } catch (error) {
    await finalizeInitiativeRun(sql, {
      runId: run.id,
      status: "failed",
      evaluatedCandidates: 0,
      createdCount: 0,
      createdGoals: 0,
      createdTasks: 0,
      createdDecisions: 0,
      suppressedCount: 0,
      noopCount: 0,
      suppressionReasons: {},
      runFailures: 1,
      failureReason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function submitInitiativeWorkViaApi(
  input: InitiativeWorkSubmission,
): Promise<{ id: string; type: "task" | "goal"; title: string; classification: unknown }> {
  const authorization = buildInternalServiceAuthorizationHeader(
    process.env.INTERNAL_SERVICE_TOKEN,
  );
  if (!authorization) {
    throw new Error("INTERNAL_SERVICE_TOKEN is required for initiative work submission");
  }

  const origin = process.env.HIVEWRIGHT_INTERNAL_BASE_URL
    ?? `http://localhost:${process.env.PORT ?? "3002"}`;
  const response = await fetch(`${origin}/api/work`, {
    method: "POST",
    headers: {
      "authorization": authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...input,
      createdBy: "initiative-engine",
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Initiative work submission failed (${response.status} ${response.statusText}): ${detail.slice(0, 300)}`,
    );
  }

  const payload = await response.json() as {
    data?: { id: string; type: "task" | "goal"; title: string; classification: unknown };
  };
  if (!payload.data) {
    throw new Error("Initiative work submission returned no data payload");
  }
  return payload.data;
}

async function fetchHiveQueueMetrics(
  sql: Sql,
  hiveId: string,
): Promise<HiveQueueMetrics> {
  const [row] = await sql<Array<{ open_tasks: number; pending_decisions: number }>>`
    SELECT
      (
        SELECT COUNT(*)::int
        FROM tasks
        WHERE hive_id = ${hiveId}
          AND status IN ('pending', 'active', 'blocked', 'in_review')
      ) AS open_tasks,
      (
        SELECT COUNT(*)::int
        FROM decisions
        WHERE hive_id = ${hiveId}
          AND status IN ('pending', 'ea_review')
      ) AS pending_decisions
  `;

  return {
    openTasks: row?.open_tasks ?? 0,
    pendingDecisions: row?.pending_decisions ?? 0,
  };
}

async function findDormantGoalCandidates(
  sql: Sql,
  hiveId: string,
  targetGoalId?: string | null,
): Promise<DormantGoalCandidate[]> {
  return sql<DormantGoalCandidate[]>`
    SELECT
      g.id AS "goalId",
      g.project_id AS "projectId",
      g.title AS "goalTitle",
      g.description AS "goalDescription",
      GREATEST(
        g.updated_at,
        COALESCE((SELECT MAX(gc.created_at) FROM goal_comments gc WHERE gc.goal_id = g.id), g.updated_at),
        COALESCE((SELECT MAX(gd.updated_at) FROM goal_documents gd WHERE gd.goal_id = g.id), g.updated_at)
      ) AS "lastGoalProgressAt",
      EXTRACT(EPOCH FROM (
        NOW() - GREATEST(
          g.updated_at,
          COALESCE((SELECT MAX(gc.created_at) FROM goal_comments gc WHERE gc.goal_id = g.id), g.updated_at),
          COALESCE((SELECT MAX(gd.updated_at) FROM goal_documents gd WHERE gd.goal_id = g.id), g.updated_at)
        )
      )) / 3600 AS "hoursSinceGoalProgress"
    FROM goals g
    WHERE g.hive_id = ${hiveId}
      AND (${targetGoalId ?? null}::uuid IS NULL OR g.id = ${targetGoalId ?? null}::uuid)
      AND g.status = 'active'
      AND NOT (g.session_id IS NULL AND g.created_at > NOW() - interval '1 hour')
      AND GREATEST(
        g.updated_at,
        COALESCE((SELECT MAX(gc.created_at) FROM goal_comments gc WHERE gc.goal_id = g.id), g.updated_at),
        COALESCE((SELECT MAX(gd.updated_at) FROM goal_documents gd WHERE gd.goal_id = g.id), g.updated_at)
      ) < NOW() - (${DORMANT_GOAL_MIN_AGE_HOURS} * interval '1 hour')
    ORDER BY "hoursSinceGoalProgress" DESC, g.created_at ASC
    LIMIT 25
  `;
}

async function loadScopedDormantGoalContext(
  sql: Sql,
  hiveId: string,
  targetGoalId: string,
): Promise<ScopedDormantGoalContext> {
  const [row] = await sql<Array<{ targetGoalTitle: string | null; alternateDormantGoalCount: number }>>`
    SELECT
      (
        SELECT g.title
        FROM goals g
        WHERE g.id = ${targetGoalId}::uuid
          AND g.hive_id = ${hiveId}
        LIMIT 1
      ) AS "targetGoalTitle",
      (
        SELECT COUNT(*)::int
        FROM goals g
        WHERE g.hive_id = ${hiveId}
          AND g.id <> ${targetGoalId}::uuid
          AND g.status = 'active'
          AND NOT (g.session_id IS NULL AND g.created_at > NOW() - interval '1 hour')
          AND GREATEST(
            g.updated_at,
            COALESCE((SELECT MAX(gc.created_at) FROM goal_comments gc WHERE gc.goal_id = g.id), g.updated_at),
            COALESCE((SELECT MAX(gd.updated_at) FROM goal_documents gd WHERE gd.goal_id = g.id), g.updated_at)
          ) < NOW() - (${DORMANT_GOAL_MIN_AGE_HOURS} * interval '1 hour')
      ) AS "alternateDormantGoalCount"
  `;

  return {
    targetGoalId,
    targetGoalTitle: row?.targetGoalTitle ?? null,
    alternateDormantGoalCount: row?.alternateDormantGoalCount ?? 0,
  };
}

async function findExistingOpenGoalTask(
  sql: Sql,
  goalId: string,
): Promise<{ id: string; status: string; createdBy: string | null; assignedTo: string | null } | null> {
  const [row] = await sql<
    Array<{ id: string; status: string; createdBy: string | null; assignedTo: string | null }>
  >`
    SELECT
      id,
      status,
      created_by AS "createdBy",
      assigned_to AS "assignedTo"
    FROM tasks
    WHERE goal_id = ${goalId}
      AND status IN ('pending', 'active', 'blocked', 'in_review')
    ORDER BY
      CASE WHEN created_by = 'initiative-engine' THEN 0 ELSE 1 END,
      created_at DESC
    LIMIT 1
  `;
  return row ?? null;
}

function buildDormantGoalTaskBrief(candidate: DormantGoalCandidate): string {
  const hoursSinceGoalProgress = Number(candidate.hoursSinceGoalProgress);
  const descriptionBlock = candidate.goalDescription?.trim()
    ? `Goal description:\n${candidate.goalDescription.trim()}\n\n`
    : "";

  return [
    `Restart momentum on goal: ${candidate.goalTitle}.`,
    "",
    `${descriptionBlock}This goal has gone ${hoursSinceGoalProgress.toFixed(1)} hours without goal-level progress.`,
    "Create or perform the most concrete next step that moves the goal forward now.",
    "",
    "Requirements:",
    "- inspect the current goal context and any existing artifacts before changing anything",
    "- pick a narrow, executable next slice rather than rewriting the whole plan",
    "- leave a clear result summary so the next run can tell progress resumed",
  ].join("\n");
}

function logInitiativePolicyBlock(input: {
  hiveId: string;
  goalId: string;
  candidateKey: string;
  decision: "allow" | "suppress";
  reason: string | null;
  rationale: string;
  sensitivity: string;
  escalationPath: string | null;
}) {
  console.warn("[initiative-policy] blocked autonomous work creation", input);
}

async function persistDecision(
  sql: Sql,
  input: {
    runId: string;
    hiveId: string;
    triggerType: string;
    goalId: string;
    candidateKey: string;
    dedupeKey: string;
    actionTaken: InitiativeActionTaken;
    rationale: string;
    suppressionReason?: string | null;
    evidence: unknown;
    actionPayload?: unknown;
    createdGoalId?: string | null;
    createdTaskId?: string | null;
  },
): Promise<InitiativeCandidateOutcome> {
  const evidence = input.evidence ?? {};
  const row = await recordInitiativeDecision(sql, {
    runId: input.runId,
    hiveId: input.hiveId,
    triggerType: input.triggerType,
    candidateKey: input.candidateKey,
    candidateRef: input.goalId,
    actionTaken: input.actionTaken,
    rationale: input.rationale,
    suppressionReason: input.suppressionReason ?? null,
    dedupeKey: input.dedupeKey,
    cooldownHours: INITIATIVE_COOLDOWN_HOURS,
    perRunCap: MAX_CREATED_TASKS_PER_RUN,
    perDayCap: MAX_CREATED_TASKS_PER_DAY,
    evidence,
    actionPayload: input.actionPayload,
    createdGoalId: input.createdGoalId ?? null,
    createdTaskId: input.createdTaskId ?? null,
  });

  return {
    decisionId: row.id,
    goalId: input.goalId,
    candidateKey: input.candidateKey,
    dedupeKey: input.dedupeKey,
    actionTaken: input.actionTaken,
    suppressionReason: input.suppressionReason ?? null,
    rationale: input.rationale,
    createdGoalId: input.createdGoalId ?? null,
    createdTaskId: input.createdTaskId ?? null,
    evidence,
  };
}

function summarizeRun(runId: string, outcomes: InitiativeCandidateOutcome[]) {
  const suppressionReasons: Record<string, number> = {};
  let createdTasks = 0;
  let suppressedCount = 0;
  let noopCount = 0;

  for (const outcome of outcomes) {
    if (outcome.actionTaken === "create_task") createdTasks += 1;
    if (outcome.actionTaken === "suppress") {
      suppressedCount += 1;
      if (outcome.suppressionReason) {
        suppressionReasons[outcome.suppressionReason] =
          (suppressionReasons[outcome.suppressionReason] ?? 0) + 1;
      }
    }
    if (outcome.actionTaken === "noop") noopCount += 1;
  }

  return {
    runId,
    status: "completed" as const,
    evaluatedCandidates: outcomes.length,
    createdCount: createdTasks,
    createdGoals: 0,
    createdTasks,
    createdDecisions: 0,
    suppressedCount,
    noopCount,
    suppressionReasons,
    runFailures: noopCount,
    failureReason: null,
  };
}
