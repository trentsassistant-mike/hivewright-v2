import type { JSONValue, Sql } from "postgres";

export type InitiativeActionTaken =
  | "create_goal"
  | "create_task"
  | "decision"
  | "suppress"
  | "noop";

export interface InitiativeRunTriggerRecord {
  type: string;
  ref?: string | null;
}

export interface CreateInitiativeRunInput {
  hiveId: string;
  trigger: InitiativeRunTriggerRecord;
  guardrailConfig: Record<string, number | string | null>;
}

export interface RecordInitiativeDecisionInput {
  runId: string;
  hiveId: string;
  triggerType: string;
  candidateKey: string;
  candidateRef?: string | null;
  actionTaken: InitiativeActionTaken;
  rationale: string;
  suppressionReason?: string | null;
  dedupeKey?: string | null;
  cooldownHours?: number | null;
  perRunCap?: number | null;
  perDayCap?: number | null;
  evidence?: unknown;
  actionPayload?: unknown;
  createdGoalId?: string | null;
  createdTaskId?: string | null;
  createdDecisionId?: string | null;
}

export interface FinalizeInitiativeRunInput {
  runId: string;
  status: "completed" | "failed";
  completedAt?: Date;
  evaluatedCandidates: number;
  createdCount: number;
  createdGoals: number;
  createdTasks: number;
  createdDecisions: number;
  suppressedCount: number;
  noopCount: number;
  suppressionReasons: Record<string, number>;
  runFailures: number;
  failureReason?: string | null;
}

function toJsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value ?? {})) as JSONValue;
}

export async function createInitiativeRun(
  sql: Sql,
  input: CreateInitiativeRunInput,
): Promise<{ id: string }> {
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO initiative_runs (
      hive_id,
      trigger_type,
      trigger_ref,
      status,
      started_at,
      guardrail_config
    )
    VALUES (
      ${input.hiveId},
      ${input.trigger.type},
      ${input.trigger.ref ?? null},
      'running',
      NOW(),
      ${sql.json(toJsonValue(input.guardrailConfig))}
    )
    RETURNING id
  `;

  return row;
}

export async function recordInitiativeDecision(
  sql: Sql,
  input: RecordInitiativeDecisionInput,
): Promise<{ id: string }> {
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO initiative_run_decisions (
      run_id,
      hive_id,
      trigger_type,
      candidate_key,
      candidate_ref,
      action_taken,
      rationale,
      suppression_reason,
      dedupe_key,
      cooldown_hours,
      per_run_cap,
      per_day_cap,
      evidence,
      action_payload,
      created_goal_id,
      created_task_id,
      created_decision_id
    )
    VALUES (
      ${input.runId},
      ${input.hiveId},
      ${input.triggerType},
      ${input.candidateKey},
      ${input.candidateRef ?? null},
      ${input.actionTaken},
      ${input.rationale},
      ${input.suppressionReason ?? null},
      ${input.dedupeKey ?? null},
      ${input.cooldownHours ?? null},
      ${input.perRunCap ?? null},
      ${input.perDayCap ?? null},
      ${sql.json(toJsonValue(input.evidence))}
      ,
      ${input.actionPayload ? sql.json(toJsonValue(input.actionPayload)) : null},
      ${input.createdGoalId ?? null},
      ${input.createdTaskId ?? null},
      ${input.createdDecisionId ?? null}
    )
    RETURNING id
  `;

  return row;
}

export async function finalizeInitiativeRun(
  sql: Sql,
  input: FinalizeInitiativeRunInput,
): Promise<void> {
  await sql`
    UPDATE initiative_runs
    SET status = ${input.status},
        completed_at = ${input.completedAt ?? new Date()},
        evaluated_candidates = ${input.evaluatedCandidates},
        created_count = ${input.createdCount},
        created_goals = ${input.createdGoals},
        created_tasks = ${input.createdTasks},
        created_decisions = ${input.createdDecisions},
        suppressed_count = ${input.suppressedCount},
        noop_count = ${input.noopCount},
        suppression_reasons = ${sql.json(toJsonValue(input.suppressionReasons))},
        run_failures = ${input.runFailures},
        failure_reason = ${input.failureReason ?? null}
    WHERE id = ${input.runId}
  `;
}

export async function findRecentCreatedDecisionByDedupeKey(
  sql: Sql,
  input: { hiveId: string; dedupeKey: string; cooldownHours: number },
): Promise<{
  id: string;
  run_id: string;
  created_task_id: string | null;
  created_at: Date;
} | null> {
  const [row] = await sql<
    Array<{ id: string; run_id: string; created_task_id: string | null; created_at: Date }>
  >`
    SELECT id, run_id, created_task_id, created_at
    FROM initiative_run_decisions
    WHERE hive_id = ${input.hiveId}
      AND dedupe_key = ${input.dedupeKey}
      AND action_taken IN ('create_goal', 'create_task', 'decision')
      AND created_at > NOW() - (${input.cooldownHours} * interval '1 hour')
    ORDER BY created_at DESC
    LIMIT 1
  `;

  return row ?? null;
}

export async function countCreatedInitiativeActionsToday(
  sql: Sql,
  hiveId: string,
): Promise<number> {
  const [row] = await sql<Array<{ created_today: number }>>`
    SELECT COUNT(*)::int AS created_today
    FROM initiative_run_decisions
    WHERE hive_id = ${hiveId}
      AND action_taken IN ('create_goal', 'create_task', 'decision')
      AND created_at >= date_trunc('day', NOW())
  `;

  return row?.created_today ?? 0;
}

export async function countCreatedInitiativeActionsSince(
  sql: Sql,
  input: { hiveId: string; hours: number },
): Promise<number> {
  const [row] = await sql<Array<{ created_recently: number }>>`
    SELECT COUNT(*)::int AS created_recently
    FROM initiative_run_decisions
    WHERE hive_id = ${input.hiveId}
      AND action_taken IN ('create_goal', 'create_task', 'decision')
      AND created_at >= NOW() - (${input.hours} * interval '1 hour')
  `;

  return row?.created_recently ?? 0;
}
