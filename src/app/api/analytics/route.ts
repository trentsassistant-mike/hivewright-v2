import { sql } from "../_lib/db";
import { jsonOk, jsonError, parseSearchParams } from "../_lib/responses";
import { requireApiUser } from "../_lib/auth";
import { calculateCostCents } from "@/adapters/provider-config";
import { canAccessHive } from "@/auth/users";

type AnalyticsTaskRow = {
  assigned_to: string;
  status: string;
  fresh_input_tokens: number | null;
  cached_input_tokens: number | null;
  total_context_tokens: number | null;
  estimated_billable_cost_cents: number | null;
  cost_cents: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  model_used: string | null;
  goal_id: string | null;
  goal_title: string | null;
};

export type AnalyticsPeriod = "today" | "7d" | "30d" | "all";

const VALID_PERIODS: readonly AnalyticsPeriod[] = ["today", "7d", "30d", "all"] as const;

/**
 * Returns the inclusive lower bound for a period relative to `now`, or null
 * for "all" (no lower bound). Days are measured backward from `now` — "today"
 * means "since 00:00 local" (server local is fine; owner views one timezone).
 */
export function periodLowerBound(period: AnalyticsPeriod, now: Date): Date | null {
  if (period === "all") return null;
  if (period === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  const days = period === "7d" ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

/**
 * Format a Date as a naive local-wall-clock string (no TZ marker). `tasks.created_at`
 * is `timestamp without time zone` filled by Postgres `now()` — i.e., server-local
 * wall-clock. Comparing against an ISO-UTC string would strip the `Z` and produce a
 * timezone-sized drift; this keeps both sides in the same frame.
 */
export function toNaiveLocalTimestamp(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/**
 * Prefer estimated_billable_cost_cents (set by stage-1 normalizer). Fall back
 * to stored cost_cents, then compute from legacy token columns if both are
 * absent — catches rows written before the pricing map covered the model.
 */
function effectiveCostCents(row: AnalyticsTaskRow): number {
  if (row.estimated_billable_cost_cents && row.estimated_billable_cost_cents > 0) {
    return row.estimated_billable_cost_cents;
  }
  if (row.cost_cents && row.cost_cents > 0) return row.cost_cents;
  const tin = row.tokens_input ?? 0;
  const tout = row.tokens_output ?? 0;
  if (tin === 0 && tout === 0) return 0;
  return calculateCostCents(row.model_used ?? "openai-codex/gpt-5.4", tin, tout);
}

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const params = parseSearchParams(request.url);
    const hiveId = params.get("hiveId");
    if (!hiveId) return jsonError("hiveId is required", 400);
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this hive", 403);
      }
    }

    const rawPeriod = (params.get("period") ?? "30d") as AnalyticsPeriod;
    const period: AnalyticsPeriod = VALID_PERIODS.includes(rawPeriod) ? rawPeriod : "30d";
    const from = periodLowerBound(period, new Date());

    const rows = (from
      ? await sql`
          SELECT t.assigned_to, t.status,
                 t.fresh_input_tokens, t.cached_input_tokens,
                 t.total_context_tokens, t.estimated_billable_cost_cents,
                 t.cost_cents, t.tokens_input, t.tokens_output,
                 t.model_used, t.goal_id, g.title AS goal_title
          FROM tasks t
          LEFT JOIN goals g ON g.id = t.goal_id
          WHERE t.hive_id = ${hiveId}
            AND t.created_at >= ${toNaiveLocalTimestamp(from)}
        `
      : await sql`
          SELECT t.assigned_to, t.status,
                 t.fresh_input_tokens, t.cached_input_tokens,
                 t.total_context_tokens, t.estimated_billable_cost_cents,
                 t.cost_cents, t.tokens_input, t.tokens_output,
                 t.model_used, t.goal_id, g.title AS goal_title
          FROM tasks t
          LEFT JOIN goals g ON g.id = t.goal_id
          WHERE t.hive_id = ${hiveId}
        `) as unknown as AnalyticsTaskRow[];

    let completed = 0;
    let failed = 0;
    let totalCostCents = 0;
    let totalContextTokens = 0;
    let totalFreshInputTokens = 0;
    let totalCachedInputTokens = 0;
    const roleMap = new Map<string, {
      assignedTo: string;
      taskCount: number;
      totalCostCents: number;
      totalContextTokens: number;
      totalFreshInputTokens: number;
      totalCachedInputTokens: number;
      totalTokensInput: number;
      totalTokensOutput: number;
    }>();
    const goalMap = new Map<string, {
      goalId: string;
      goalTitle: string;
      taskCount: number;
      totalCostCents: number;
      totalContextTokens: number;
    }>();

    for (const row of rows) {
      if (row.status === "completed") completed++;
      if (row.status === "failed") failed++;
      const cost = effectiveCostCents(row);
      totalCostCents += cost;
      const ctx = row.total_context_tokens ?? row.tokens_input ?? 0;
      const fresh = row.fresh_input_tokens ?? ctx;
      const cached = row.cached_input_tokens ?? 0;
      totalContextTokens += ctx;
      totalFreshInputTokens += fresh;
      totalCachedInputTokens += cached;

      const role = row.assigned_to || "unassigned";
      const roleEntry = roleMap.get(role) ?? {
        assignedTo: role,
        taskCount: 0,
        totalCostCents: 0,
        totalContextTokens: 0,
        totalFreshInputTokens: 0,
        totalCachedInputTokens: 0,
        totalTokensInput: 0,
        totalTokensOutput: 0,
      };
      roleEntry.taskCount++;
      roleEntry.totalCostCents += cost;
      roleEntry.totalContextTokens += ctx;
      roleEntry.totalFreshInputTokens += fresh;
      roleEntry.totalCachedInputTokens += cached;
      roleEntry.totalTokensInput += row.tokens_input ?? 0;
      roleEntry.totalTokensOutput += row.tokens_output ?? 0;
      roleMap.set(role, roleEntry);

      if (row.goal_id) {
        const goalEntry = goalMap.get(row.goal_id) ?? {
          goalId: row.goal_id,
          goalTitle: row.goal_title ?? row.goal_id,
          taskCount: 0,
          totalCostCents: 0,
          totalContextTokens: 0,
        };
        goalEntry.taskCount++;
        goalEntry.totalCostCents += cost;
        goalEntry.totalContextTokens += ctx;
        goalMap.set(row.goal_id, goalEntry);
      }
    }

    return jsonOk({
      totals: {
        totalTasks: rows.length,
        completed,
        failed,
        totalCostCents,
        totalContextTokens,
        totalFreshInputTokens,
        totalCachedInputTokens,
      },
      byRole: Array.from(roleMap.values()).sort((a, b) => b.totalCostCents - a.totalCostCents),
      byGoal: Array.from(goalMap.values()).sort((a, b) => b.totalCostCents - a.totalCostCents),
      period,
      from: from ? toNaiveLocalTimestamp(from) : null,
    });
  } catch {
    return jsonError("Failed to fetch analytics", 500);
  }
}
