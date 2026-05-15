import type { Sql } from "postgres";
import {
  deriveAiBudgetStatus,
  effectiveTaskSpendCents,
  getAiBudgetWindowStart,
  normalizeAiBudgetSettings,
  AI_BUDGET_PAUSE_REASON,
  AI_BUDGET_PAUSED_BY,
  type BudgetWindow,
  type AiBudgetStatus,
  type AiBudgetTaskSpendRow,
} from "@/budget/ai-budget";

export { getAiBudgetWindowStart, normalizeAiBudgetSettings } from "@/budget/ai-budget";
import { getHiveCreationPause, setHiveCreationPause } from "@/operations/creation-pause";

type TaskSpendRow = {
  estimated_billable_cost_cents: number | null;
  cost_cents: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  model_used: string | null;
};

type HiveBudgetSettingsRow = {
  ai_budget_cap_cents: number | null;
  ai_budget_window: string | null;
};

async function loadHiveAiBudgetSettings(sql: Sql, hiveId: string): Promise<{ capCents: number; window: BudgetWindow }> {
  const [row] = await sql<HiveBudgetSettingsRow[]>`
    SELECT ai_budget_cap_cents, ai_budget_window
    FROM hives
    WHERE id = ${hiveId}::uuid
  `;

  return normalizeAiBudgetSettings({
    capCents: row?.ai_budget_cap_cents,
    window: row?.ai_budget_window,
  });
}

async function loadConsumedCents(sql: Sql, hiveId: string, window: BudgetWindow): Promise<number> {
  const windowStart = getAiBudgetWindowStart(window);
  const rows = await sql<TaskSpendRow[]>`
    SELECT estimated_billable_cost_cents, cost_cents, tokens_input, tokens_output, model_used
    FROM tasks
    WHERE hive_id = ${hiveId}::uuid
      AND (${windowStart}::timestamptz IS NULL OR COALESCE(started_at, updated_at, created_at) >= ${windowStart}::timestamptz)
  `;

  return rows.reduce((total, row) => (
    total + effectiveTaskSpendCents({
      estimatedBillableCostCents: row.estimated_billable_cost_cents,
      costCents: row.cost_cents,
      tokensInput: row.tokens_input,
      tokensOutput: row.tokens_output,
      modelUsed: row.model_used,
    } satisfies AiBudgetTaskSpendRow)
  ), 0);
}

export async function summarizeAiBudget(
  sql: Sql,
  hiveId: string,
): Promise<AiBudgetStatus> {
  const settings = await loadHiveAiBudgetSettings(sql, hiveId);
  const [consumedCents, creationPause] = await Promise.all([
    loadConsumedCents(sql, hiveId, settings.window),
    getHiveCreationPause(sql, hiveId),
  ]);

  return deriveAiBudgetStatus({
    capCents: settings.capCents,
    window: settings.window,
    consumedCents,
    blocksNewWork: creationPause.paused,
    reason: creationPause.reason,
  });
}

export async function enforceAiBudget(
  sql: Sql,
  hiveId: string,
): Promise<AiBudgetStatus> {
  const budget = await summarizeAiBudget(sql, hiveId);
  if (budget.state !== "breached" || budget.enforcement.blocksNewWork) {
    return budget;
  }

  const creationPause = await setHiveCreationPause(sql, {
    hiveId,
    paused: true,
    reason: AI_BUDGET_PAUSE_REASON,
    changedBy: AI_BUDGET_PAUSED_BY,
  });

  return deriveAiBudgetStatus({
    consumedCents: budget.consumedCents,
    capCents: budget.capCents,
    window: budget.window,
    blocksNewWork: creationPause.paused,
    reason: creationPause.reason,
  });
}
