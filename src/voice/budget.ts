import { db } from "@/db";
import { voiceSessions } from "@/db/schema/voice-sessions";
import { and, eq, gte, sql } from "drizzle-orm";

/**
 * Voice LLM budget assessment.
 *
 * Rolls up this-calendar-month `voice_sessions.llm_cost_cents` for a hive
 * and compares the total against the caller-provided cap (sourced from
 * `VOICE_MONTHLY_LLM_CAP_CENTS` env). Produces four-tier guidance consumed by the voice
 * adapter:
 *
 *   ratio < 0.8  → warn=false, model=opus,   pause=false   (normal)
 *   ratio >= 0.8 → warn=true,  model=opus,   pause=false   (verbal warning)
 *   ratio >= 1.0 → warn=true,  model=sonnet, pause=false   (downgrade)
 *   ratio >= 1.2 → warn=true,  model=sonnet, pause=true    (hang up)
 *
 * The caller decides what to do with `pause` — this helper is pure and
 * has no side effects.
 */

export interface BudgetLimits {
  monthlyLlmCap: number; // cents
}

export interface BudgetAssessment {
  warn: boolean;
  model: "opus" | "sonnet";
  pause: boolean;
  spendCents: number;
  capCents: number;
}

export async function assessBudget(
  hiveId: string,
  limits: BudgetLimits,
): Promise<BudgetAssessment> {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const rows = await db
    .select({
      total: sql<number>`COALESCE(SUM(${voiceSessions.llmCostCents}), 0)::int`,
    })
    .from(voiceSessions)
    .where(
      and(
        eq(voiceSessions.hiveId, hiveId),
        gte(voiceSessions.startedAt, startOfMonth),
      ),
    );
  const spend = rows[0]?.total ?? 0;
  const ratio = limits.monthlyLlmCap > 0 ? spend / limits.monthlyLlmCap : 0;
  return {
    spendCents: spend,
    capCents: limits.monthlyLlmCap,
    warn: ratio >= 0.8,
    model: ratio >= 1.0 ? "sonnet" : "opus",
    pause: ratio >= 1.2,
  };
}
