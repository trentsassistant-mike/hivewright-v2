import { calculateCostCents } from "@/adapters/provider-config";

export const DEFAULT_AI_BUDGET_CAP_CENTS = 100_000;
export const AI_BUDGET_WARNING_THRESHOLD_PCT = 80;
export const AI_BUDGET_BREACH_THRESHOLD_PCT = 100;
export const AI_BUDGET_PAUSE_REASON = "Paused by AI spend budget breach";
export const AI_BUDGET_PAUSED_BY = "system:ai-budget";

export type AiBudgetState = "normal" | "warning" | "breached";
export type BudgetWindow = "daily" | "weekly" | "monthly" | "all_time";
export type BudgetScope = "hive" | "outcome" | "goal" | "task";

export const AI_BUDGET_WINDOWS: readonly BudgetWindow[] = [
  "daily",
  "weekly",
  "monthly",
  "all_time",
] as const;

export interface AiBudgetTaskSpendRow {
  estimatedBillableCostCents: number | null;
  costCents: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  modelUsed: string | null;
}

export interface AiBudgetStatus {
  currency: "USD";
  capCents: number;
  consumedCents: number;
  remainingCents: number;
  progressPct: number;
  warningThresholdPct: 80;
  breachedThresholdPct: 100;
  state: AiBudgetState;
  overBudgetCents: number;
  window: BudgetWindow;
  scope: "hive";
  enforcement: {
    mode: "creation_pause";
    blocksNewWork: boolean;
    reason: string | null;
  };
}

export interface BudgetSettings {
  scope: BudgetScope;
  capCents: number;
  window: BudgetWindow;
}

export function normalizeBudgetWindow(value: unknown): BudgetWindow {
  return typeof value === "string" && (AI_BUDGET_WINDOWS as readonly string[]).includes(value)
    ? (value as BudgetWindow)
    : "all_time";
}

export function normalizeAiBudgetSettings(input?: {
  capCents?: number | null;
  window?: unknown;
} | null): Pick<BudgetSettings, "capCents" | "window"> {
  const capCents = typeof input?.capCents === "number" && Number.isFinite(input.capCents) && input.capCents >= 0
    ? Math.trunc(input.capCents)
    : DEFAULT_AI_BUDGET_CAP_CENTS;
  return {
    capCents,
    window: normalizeBudgetWindow(input?.window),
  };
}

export function getAiBudgetWindowStart(window: BudgetWindow, now = new Date()): Date | null {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  if (window === "daily") return start;
  if (window === "weekly") {
    const day = start.getUTCDay();
    const daysSinceMonday = (day + 6) % 7;
    start.setUTCDate(start.getUTCDate() - daysSinceMonday);
    return start;
  }
  if (window === "monthly") {
    start.setUTCDate(1);
    return start;
  }
  return null;
}

function normalizeCents(value: number | null | undefined, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

export function effectiveTaskSpendCents(row: AiBudgetTaskSpendRow): number {
  if (row.estimatedBillableCostCents !== null && row.estimatedBillableCostCents !== undefined) {
    return normalizeCents(row.estimatedBillableCostCents);
  }
  if (row.costCents && row.costCents > 0) return row.costCents;
  const tokensInput = row.tokensInput ?? 0;
  const tokensOutput = row.tokensOutput ?? 0;
  if (tokensInput === 0 && tokensOutput === 0) return 0;
  return calculateCostCents(row.modelUsed ?? "openai-codex/gpt-5.4", tokensInput, tokensOutput);
}

export function deriveAiBudgetStatus(input: {
  capCents?: number | null;
  window?: BudgetWindow | null;
  consumedCents: number | null | undefined;
  blocksNewWork: boolean;
  reason?: string | null;
}): AiBudgetStatus {
  const settings = normalizeAiBudgetSettings({ capCents: input.capCents, window: input.window });
  const capCents = settings.capCents;
  const consumedCents = normalizeCents(input.consumedCents);
  const warningThresholdCents = Math.ceil((capCents * AI_BUDGET_WARNING_THRESHOLD_PCT) / 100);

  let state: AiBudgetState = "normal";
  if (consumedCents >= capCents) state = "breached";
  else if (consumedCents >= warningThresholdCents) state = "warning";

  const rawProgressPct = capCents > 0 ? (consumedCents / capCents) * 100 : 0;

  return {
    currency: "USD",
    capCents,
    consumedCents,
    remainingCents: Math.max(0, capCents - consumedCents),
    progressPct: Math.min(100, Math.round(rawProgressPct)),
    warningThresholdPct: AI_BUDGET_WARNING_THRESHOLD_PCT,
    breachedThresholdPct: AI_BUDGET_BREACH_THRESHOLD_PCT,
    state,
    overBudgetCents: Math.max(0, consumedCents - capCents),
    window: settings.window,
    scope: "hive",
    enforcement: {
      mode: "creation_pause",
      blocksNewWork: input.blocksNewWork,
      reason: input.reason ?? null,
    },
  };
}
