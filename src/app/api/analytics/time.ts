export type AnalyticsPeriod = "today" | "7d" | "30d" | "all";

export const VALID_PERIODS: readonly AnalyticsPeriod[] = ["today", "7d", "30d", "all"] as const;

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
