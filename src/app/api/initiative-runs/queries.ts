import type { Sql } from "postgres";
import { sql as appSql } from "../_lib/db";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const DEFAULT_WINDOW_HOURS = 24 * 7;
export const MAX_WINDOW_HOURS = 24 * 30;

export interface InitiativeRunRow {
  id: string;
  hiveId: string;
  trigger: string;
  triggerRef: string | null;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  evaluatedCandidates: number;
  createdCount: number;
  created: {
    goals: number;
    tasks: number;
    decisions: number;
  };
  suppressedCount: number;
  noopCount: number;
  suppressionReasons: Record<string, number>;
  runFailures: number;
  failureReason: string | null;
}

export interface InitiativeSuppressionReasonCount {
  reason: string;
  count: number;
}

export interface InitiativeRunSummary {
  windowHours: number;
  runCount: number;
  completedRuns: number;
  failedRuns: number;
  evaluatedCandidates: number;
  createdItems: number;
  suppressedItems: number;
  runFailures: number;
  suppressionReasons: InitiativeSuppressionReasonCount[];
}

interface DbRow {
  id: string;
  hive_id: string;
  trigger_type: string;
  trigger_ref: string | null;
  status: string;
  started_at: Date;
  completed_at: Date | null;
  evaluated_candidates: number | null;
  created_count: number | null;
  created_goals: number | null;
  created_tasks: number | null;
  created_decisions: number | null;
  suppressed_count: number | null;
  noop_count: number | null;
  suppression_reasons: unknown;
  run_failures: number | null;
  failure_reason: string | null;
}

function asSuppressionReasons(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(
        ([reason, count]): [string, number] => [reason, Number(count)],
      )
      .filter(([, count]) => Number.isFinite(count) && count > 0),
  );
}

function mapRow(row: DbRow): InitiativeRunRow {
  return {
    id: row.id,
    hiveId: row.hive_id,
    trigger: row.trigger_type,
    triggerRef: row.trigger_ref,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    evaluatedCandidates: Number(row.evaluated_candidates ?? 0),
    createdCount: Number(row.created_count ?? 0),
    created: {
      goals: Number(row.created_goals ?? 0),
      tasks: Number(row.created_tasks ?? 0),
      decisions: Number(row.created_decisions ?? 0),
    },
    suppressedCount: Number(row.suppressed_count ?? 0),
    noopCount: Number(row.noop_count ?? 0),
    suppressionReasons: asSuppressionReasons(row.suppression_reasons),
    runFailures: Number(row.run_failures ?? 0),
    failureReason: row.failure_reason,
  };
}

export async function fetchInitiativeRuns(
  db: Sql,
  hiveId: string,
  limit: number,
): Promise<InitiativeRunRow[]> {
  const rows = await db<DbRow[]>`
    SELECT id, hive_id, trigger_type, trigger_ref, status, started_at, completed_at,
           evaluated_candidates, created_count, created_goals, created_tasks,
           created_decisions, suppressed_count, noop_count, suppression_reasons,
           run_failures, failure_reason
    FROM initiative_runs
    WHERE hive_id = ${hiveId}::uuid
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
  return rows.map(mapRow);
}

export async function fetchLatestInitiativeRun(
  db: Sql,
  hiveId: string,
): Promise<InitiativeRunRow | null> {
  const rows = await fetchInitiativeRuns(db, hiveId, 1);
  return rows[0] ?? null;
}

export async function fetchInitiativeRunSummary(
  db: Sql,
  hiveId: string,
  windowHours: number,
): Promise<InitiativeRunSummary> {
  const rows = await db<DbRow[]>`
    SELECT id, hive_id, trigger_type, trigger_ref, status, started_at, completed_at,
           evaluated_candidates, created_count, created_goals, created_tasks,
           created_decisions, suppressed_count, noop_count, suppression_reasons,
           run_failures, failure_reason
    FROM initiative_runs
    WHERE hive_id = ${hiveId}::uuid
      AND started_at >= NOW() - (${windowHours} * INTERVAL '1 hour')
    ORDER BY started_at DESC
  `;

  const suppressionCounts = new Map<string, number>();
  let runCount = 0;
  let completedRuns = 0;
  let failedRuns = 0;
  let evaluatedCandidates = 0;
  let createdItems = 0;
  let suppressedItems = 0;
  let runFailures = 0;

  for (const row of rows.map(mapRow)) {
    runCount += 1;
    if (row.status === "failed" || row.runFailures > 0) failedRuns += 1;
    else completedRuns += 1;
    evaluatedCandidates += row.evaluatedCandidates;
    createdItems += row.createdCount;
    suppressedItems += row.suppressedCount;
    runFailures += row.runFailures;
    for (const [reason, count] of Object.entries(row.suppressionReasons)) {
      suppressionCounts.set(reason, (suppressionCounts.get(reason) ?? 0) + count);
    }
  }

  return {
    windowHours,
    runCount,
    completedRuns,
    failedRuns,
    evaluatedCandidates,
    createdItems,
    suppressedItems,
    runFailures,
    suppressionReasons: Array.from(suppressionCounts.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

export { appSql };

export interface InitiativeRunDecisionRow {
  id: string;
  runId: string;
  candidate_key: string;
  candidate_ref: string | null;
  candidate_kind: string;
  target_goal_id: string | null;
  target_goal_title: string | null;
  action_taken: string;
  created_goal_id: string | null;
  created_goal_title: string | null;
  created_task_id: string | null;
  created_task_title: string | null;
  suppression_reason: string | null;
  rationale: string;
  dedupe_key: string | null;
  evidence: unknown;
  created_at: Date;
}

interface DecisionDbRow {
  id: string;
  run_id: string;
  candidate_key: string;
  candidate_ref: string | null;
  candidate_kind: string | null;
  target_goal_id: string | null;
  target_goal_title: string | null;
  action_taken: string;
  created_goal_id: string | null;
  created_goal_title: string | null;
  created_task_id: string | null;
  created_task_title: string | null;
  suppression_reason: string | null;
  rationale: string;
  dedupe_key: string | null;
  evidence: unknown;
  created_at: Date;
}

function mapDecisionRow(row: DecisionDbRow): InitiativeRunDecisionRow {
  return {
    id: row.id,
    runId: row.run_id,
    candidate_key: row.candidate_key,
    candidate_ref: row.candidate_ref,
    candidate_kind: row.candidate_kind ?? row.candidate_key.split(":")[0] ?? "candidate",
    target_goal_id: row.target_goal_id,
    target_goal_title: row.target_goal_title,
    action_taken: row.action_taken,
    created_goal_id: row.created_goal_id,
    created_goal_title: row.created_goal_title,
    created_task_id: row.created_task_id,
    created_task_title: row.created_task_title,
    suppression_reason: row.suppression_reason,
    rationale: row.rationale,
    dedupe_key: row.dedupe_key,
    evidence: row.evidence,
    created_at: row.created_at,
  };
}

export async function fetchInitiativeRunById(
  db: Sql,
  hiveId: string,
  runId: string,
): Promise<InitiativeRunRow | null> {
  const [row] = await db<DbRow[]>`
    SELECT id, hive_id, trigger_type, trigger_ref, status, started_at, completed_at,
           evaluated_candidates, created_count, created_goals, created_tasks,
           created_decisions, suppressed_count, noop_count, suppression_reasons,
           run_failures, failure_reason
    FROM initiative_runs
    WHERE hive_id = ${hiveId}::uuid
      AND id = ${runId}::uuid
    LIMIT 1
  `;

  return row ? mapRow(row) : null;
}

export async function fetchInitiativeRunDecisions(
  db: Sql,
  hiveId: string,
  runId: string,
): Promise<InitiativeRunDecisionRow[]> {
  const rows = await db<DecisionDbRow[]>`
    SELECT d.id,
           d.run_id,
           d.candidate_key,
           d.candidate_ref,
           COALESCE(d.evidence -> 'candidate' ->> 'kind', split_part(d.candidate_key, ':', 1)) AS candidate_kind,
           COALESCE(d.candidate_ref, d.evidence -> 'candidate' ->> 'goalId') AS target_goal_id,
           COALESCE(g.title, d.evidence -> 'candidate' ->> 'goalTitle') AS target_goal_title,
           d.action_taken,
           d.created_goal_id,
           created_goal.title AS created_goal_title,
           d.created_task_id,
           t.title AS created_task_title,
           d.suppression_reason,
           d.rationale,
           d.dedupe_key,
           d.evidence,
           d.created_at
    FROM initiative_run_decisions d
    LEFT JOIN goals g ON g.id::text = d.candidate_ref
    LEFT JOIN goals created_goal ON created_goal.id = d.created_goal_id
    LEFT JOIN tasks t ON t.id = d.created_task_id
    WHERE d.hive_id = ${hiveId}::uuid
      AND d.run_id = ${runId}::uuid
    ORDER BY d.created_at ASC, d.id ASC
  `;

  return rows.map(mapDecisionRow);
}

export function summarizeInitiativeRun(
  row: InitiativeRunRow | null,
): (InitiativeRunRow & { topSuppressionReasons: InitiativeSuppressionReasonCount[] }) | null {
  if (!row) return null;
  const topSuppressionReasons = Object.entries(row.suppressionReasons)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 3);

  return {
    hiveId: row.hiveId,
    id: row.id,
    trigger: row.trigger,
    triggerRef: row.triggerRef,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    evaluatedCandidates: row.evaluatedCandidates,
    createdCount: row.createdCount,
    created: row.created,
    suppressedCount: row.suppressedCount,
    noopCount: row.noopCount,
    suppressionReasons: row.suppressionReasons,
    runFailures: row.runFailures,
    failureReason: row.failureReason,
    topSuppressionReasons,
  };
}
