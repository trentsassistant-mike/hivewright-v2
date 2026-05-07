"use client";

import { useEffect, useState } from "react";
import { useHiveContext } from "@/components/hive-context";

type RoleSummary = {
  assignedTo: string;
  taskCount: number;
  totalCostCents: number;
  totalContextTokens?: number;
  totalFreshInputTokens?: number;
  totalCachedInputTokens?: number;
  totalTokensInput: number;
  totalTokensOutput: number;
};

type GoalSummary = {
  goalId: string;
  goalTitle: string;
  taskCount: number;
  totalCostCents: number;
  totalContextTokens?: number;
};

type AnalyticsResponse = {
  totals: {
    totalTasks: number;
    completed: number;
    failed: number;
    totalCostCents: number;
    totalContextTokens?: number;
    totalFreshInputTokens?: number;
    totalCachedInputTokens?: number;
  };
  byRole: RoleSummary[];
  byGoal: GoalSummary[];
  period: Period;
  from: string | null;
};

const PERIOD_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All time" },
] as const;

type Period = (typeof PERIOD_OPTIONS)[number]["value"];

export default function AnalyticsPage() {
  const { selected, loading: bizLoading } = useHiveContext();
  const [period, setPeriod] = useState<Period>("30d");
  const [byRole, setByRole] = useState<RoleSummary[]>([]);
  const [byGoal, setByGoal] = useState<GoalSummary[]>([]);
  const [totals, setTotals] = useState({
    totalTasks: 0,
    completed: 0,
    failed: 0,
    totalCostCents: 0,
    totalContextTokens: 0,
    totalFreshInputTokens: 0,
    totalCachedInputTokens: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;

    const fetchAnalytics = async () => {
      setLoading(true);
      try {
        const url = new URL("/api/analytics", window.location.origin);
        url.searchParams.set("hiveId", selected.id);
        url.searchParams.set("period", period);
        const r = await fetch(url.toString());
        const body = await r.json();
        if (cancelled) return;
        const data: AnalyticsResponse | undefined = body.data;
        if (!data) {
          setTotals({
            totalTasks: 0,
            completed: 0,
            failed: 0,
            totalCostCents: 0,
            totalContextTokens: 0,
            totalFreshInputTokens: 0,
            totalCachedInputTokens: 0,
          });
          setByRole([]);
          setByGoal([]);
          return;
        }
        setTotals({
          totalTasks: data.totals.totalTasks,
          completed: data.totals.completed,
          failed: data.totals.failed,
          totalCostCents: data.totals.totalCostCents,
          totalContextTokens: data.totals.totalContextTokens ?? 0,
          totalFreshInputTokens: data.totals.totalFreshInputTokens ?? 0,
          totalCachedInputTokens: data.totals.totalCachedInputTokens ?? 0,
        });
        setByRole(data.byRole);
        setByGoal(data.byGoal);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchAnalytics();
    return () => { cancelled = true; };
  }, [selected, period]);

  function formatCents(cents: number) {
    if (isNaN(cents)) return "$0.00";
    return `$${(cents / 100).toFixed(2)}`;
  }

  function formatNumber(value: number | undefined) {
    return (value ?? 0).toLocaleString();
  }

  function processedContext(row: RoleSummary) {
    return row.totalContextTokens ?? row.totalTokensInput;
  }

  if (bizLoading) return <p className="text-zinc-400">Loading...</p>;
  if (!selected) return <p className="text-zinc-400">No hive selected.</p>;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Cost Analytics</h1>
        <p className="text-sm text-zinc-500 mt-1">Task execution costs and token usage for {selected.name}.</p>
      </div>

      {/* Period filter tabs */}
      <div
        role="tablist"
        aria-label="Analytics period"
        className="-mx-4 flex gap-2 overflow-x-auto border-b px-4 pb-2 sm:mx-0 sm:px-0"
      >
        {PERIOD_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            role="tab"
            aria-selected={period === opt.value}
            onClick={() => setPeriod(opt.value)}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors ${
              period === opt.value
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-zinc-400">Loading analytics...</p>
      ) : (
        <>
          {/* Stat cards */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <StatCard label="Total Tasks" value={String(totals.totalTasks)} />
            <StatCard label="Completed" value={String(totals.completed)} accent="green" />
            <StatCard label="Failed" value={String(totals.failed)} accent="red" />
            <StatCard label="Processed Context" value={formatNumber(totals.totalContextTokens)} />
            <StatCard label="Total Cost" value={formatCents(totals.totalCostCents)} />
          </div>

          {/* Cost by role */}
          <section>
            <h2 className="text-lg font-medium mb-3">Cost by Role</h2>
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 dark:bg-zinc-900">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-zinc-500">Role</th>
                    <th className="px-4 py-3 text-right font-medium text-zinc-500">Tasks</th>
                    <th className="px-4 py-3 text-right font-medium text-zinc-500">Processed Context</th>
                    <th className="px-4 py-3 text-right font-medium text-zinc-500">Fresh Input</th>
                    <th className="px-4 py-3 text-right font-medium text-zinc-500">Cached Input</th>
                    <th className="px-4 py-3 text-right font-medium text-zinc-500">Output Tokens</th>
                    <th className="px-4 py-3 text-right font-medium text-zinc-500">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {byRole.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-zinc-500">
                        No data yet.
                      </td>
                    </tr>
                  ) : (
                    byRole.map((row) => (
                      <tr key={row.assignedTo} className="hover:bg-zinc-50 dark:hover:bg-zinc-900">
                        <td className="px-4 py-3 font-medium text-zinc-800 dark:text-zinc-200">
                          {row.assignedTo}
                        </td>
                        <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400">
                          {row.taskCount}
                        </td>
                        <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400">
                          {formatNumber(processedContext(row))}
                        </td>
                        <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400">
                          {formatNumber(row.totalFreshInputTokens ?? row.totalTokensInput)}
                        </td>
                        <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400">
                          {formatNumber(row.totalCachedInputTokens)}
                        </td>
                        <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400">
                          {formatNumber(row.totalTokensOutput)}
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-zinc-800 dark:text-zinc-200">
                          {formatCents(row.totalCostCents)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Cost by goal */}
          <section>
            <h2 className="text-lg font-medium mb-3">Cost by Goal</h2>
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 dark:bg-zinc-900">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-zinc-500">Goal</th>
                    <th className="px-4 py-3 text-right font-medium text-zinc-500">Tasks</th>
                    <th className="px-4 py-3 text-right font-medium text-zinc-500">Processed Context</th>
                    <th className="px-4 py-3 text-right font-medium text-zinc-500">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {byGoal.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-zinc-500">
                        No data yet.
                      </td>
                    </tr>
                  ) : (
                    byGoal.map((row) => (
                      <tr key={row.goalId} className="hover:bg-zinc-50 dark:hover:bg-zinc-900">
                        <td className="px-4 py-3 text-zinc-800 dark:text-zinc-200">{row.goalTitle}</td>
                        <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400">
                          {row.taskCount}
                        </td>
                        <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400">
                          {formatNumber(row.totalContextTokens)}
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-zinc-800 dark:text-zinc-200">
                          {formatCents(row.totalCostCents)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "green" | "red";
}) {
  const valueColor =
    accent === "green"
      ? "text-green-600 dark:text-green-400"
      : accent === "red"
        ? "text-red-600 dark:text-red-400"
        : "text-zinc-900 dark:text-zinc-100";

  return (
    <div className="rounded-lg border p-4 space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`text-2xl font-semibold ${valueColor}`}>{value}</p>
    </div>
  );
}
