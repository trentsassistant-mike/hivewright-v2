import type { Sql } from "postgres";
import { sql as appSql } from "../_lib/db";

/**
 * Shared query + summarizer plumbing for `supervisor_reports`. Both the
 * full-detail `/api/supervisor-reports` feed and the thin summary embedded
 * in `/api/brief` go through here so the two endpoints stay in lock-step
 * on column set, camelCase mapping, and the findings/actions counting
 * rules.
 */

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface SupervisorReportRow {
  id: string;
  hiveId: string;
  ranAt: Date;
  report: unknown;
  actions: unknown;
  actionOutcomes: unknown;
  agentTaskId: string | null;
  freshInputTokens: number | null;
  cachedInputTokens: number | null;
  cachedInputTokensKnown: boolean;
  totalContextTokens: number | null;
  estimatedBillableCostCents: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costCents: number | null;
}

export interface SupervisorReportSummary {
  id: string;
  ranAt: Date;
  findings: number;
  actionsEmitted: number;
  actionsApplied: number;
}

interface DbRow {
  id: string;
  hive_id: string;
  ran_at: Date;
  report: unknown;
  actions: unknown;
  action_outcomes: unknown;
  agent_task_id: string | null;
  fresh_input_tokens: number | null;
  cached_input_tokens: number | null;
  cached_input_tokens_known: boolean;
  total_context_tokens: number | null;
  estimated_billable_cost_cents: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  cost_cents: number | null;
}

function mapRow(r: DbRow): SupervisorReportRow {
  return {
    id: r.id,
    hiveId: r.hive_id,
    ranAt: r.ran_at,
    report: r.report,
    actions: r.actions,
    actionOutcomes: r.action_outcomes,
    agentTaskId: r.agent_task_id,
    freshInputTokens: r.fresh_input_tokens,
    cachedInputTokens: r.cached_input_tokens,
    cachedInputTokensKnown: r.cached_input_tokens_known,
    totalContextTokens: r.total_context_tokens,
    estimatedBillableCostCents: r.estimated_billable_cost_cents,
    tokensInput: r.tokens_input,
    tokensOutput: r.tokens_output,
    costCents: r.cost_cents,
  };
}

export async function fetchSupervisorReports(
  db: Sql,
  hiveId: string,
  limit: number,
): Promise<SupervisorReportRow[]> {
  const rows = await db<DbRow[]>`
    SELECT id, hive_id, ran_at, report, actions, action_outcomes,
           agent_task_id,
           fresh_input_tokens, cached_input_tokens, cached_input_tokens_known,
           total_context_tokens, estimated_billable_cost_cents,
           tokens_input, tokens_output, cost_cents
    FROM supervisor_reports
    WHERE hive_id = ${hiveId}::uuid
    ORDER BY ran_at DESC
    LIMIT ${limit}
  `;
  return rows.map(mapRow);
}

export async function fetchLatestSupervisorReport(
  db: Sql,
  hiveId: string,
): Promise<SupervisorReportRow | null> {
  const rows = await fetchSupervisorReports(db, hiveId, 1);
  return rows[0] ?? null;
}

export { appSql };

export function summarizeSupervisorReport(
  row: SupervisorReportRow | null,
): SupervisorReportSummary | null {
  if (!row) return null;
  const report = row.report as { findings?: unknown } | null;
  const findings = Array.isArray(report?.findings) ? report.findings.length : 0;
  const outcomes = Array.isArray(row.actionOutcomes)
    ? (row.actionOutcomes as Array<{ status?: string }>)
    : [];
  const actionsApplied = outcomes.filter((o) => o?.status === "applied").length;
  const actionsBlob = row.actions as { actions?: unknown } | null;
  const actionsEmitted = Array.isArray(actionsBlob?.actions)
    ? actionsBlob.actions.length
    : outcomes.length;
  return {
    id: row.id,
    ranAt: row.ranAt,
    findings,
    actionsEmitted,
    actionsApplied,
  };
}
