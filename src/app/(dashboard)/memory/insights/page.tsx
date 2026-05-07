"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useHiveContext } from "@/components/hive-context";

type Insight = {
  id: string;
  hive_id: string;
  hive_name: string;
  content: string;
  connection_type: string;
  affected_departments: string[];
  confidence: number;
  priority: string;
  status: string;
  curator_reason: string | null;
  curated_at: string | null;
  decision_id: string | null;
  created_at: string;
  updated_at: string;
};

const CONNECTION_BADGE: Record<string, string> = {
  cross_department: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  trend: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  anomaly: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  opportunity: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  risk: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  causal: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
  contradictory: "bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200",
  reinforcing: "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200",
};

const PRIORITY_BADGE: Record<string, string> = {
  high: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  low: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

const STATUS_OPTIONS = [
  "new",
  "acknowledged",
  "actioned",
  "escalated",
  "dismissed",
] as const;

const STATUS_HINT: Record<string, string> = {
  new: "Hasn't been touched by the curator yet — should be empty during steady state.",
  acknowledged: "Curator kept these for reference. No action required.",
  actioned: "Promoted to standing instructions and now injected into future briefs.",
  escalated: "Curator flagged these as needing your decision. Each has a row in Decisions.",
  dismissed: "Curator judged these as low-signal. Override below if you disagree.",
};

export default function InsightsPage() {
  const { selected, loading: bizLoading } = useHiveContext();
  const [status, setStatus] = useState<string>("new");
  const [insights, setInsights] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    loadInsights();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, status]);

  async function loadInsights() {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/insights", window.location.origin);
      url.searchParams.set("status", status);
      url.searchParams.set("hiveId", selected.id);
      const res = await fetch(url.toString());
      if (!res.ok) throw new Error("Failed to fetch insights");
      const data = await res.json();
      setInsights(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function override(insightId: string, newStatus: string, note: string) {
    setActingId(insightId);
    setError(null);
    try {
      const res = await fetch(`/api/insights/${insightId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: newStatus, note }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `Override failed (${res.status})`);
        return;
      }
      await loadInsights();
    } catch {
      setError("Network error during override");
    } finally {
      setActingId(null);
    }
  }

  if (bizLoading) return <p className="text-zinc-400">Loading...</p>;
  if (!selected) return <p className="text-zinc-400">No hive selected.</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Insight Inbox</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Cross-cutting patterns surfaced by the synthesis engine. The curator runs after
          synthesis and auto-classifies each one — you only need to look at <b>escalated</b>.
        </p>
      </div>

      {/* Status filter */}
      <div className="flex gap-3 items-end flex-wrap">
        <div className="space-y-1">
          <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Status
          </label>
          <div className="flex gap-1 flex-wrap">
            {STATUS_OPTIONS.map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`rounded-md px-3 py-2 text-sm capitalize transition-colors ${
                  status === s
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "border text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="text-xs text-zinc-500 italic">{STATUS_HINT[status]}</p>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Insights list */}
      {loading ? (
        <div className="text-sm text-zinc-500">Loading...</div>
      ) : insights.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-zinc-500 text-sm">
          No {status} insights found.
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-zinc-500">
            {insights.length} insight{insights.length !== 1 ? "s" : ""}
          </p>
          {insights.map((insight) => (
            <div key={insight.id} className="rounded-lg border p-4 space-y-3">
              {/* Header row */}
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      CONNECTION_BADGE[insight.connection_type] ??
                      "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
                    }`}
                  >
                    {insight.connection_type.replace(/_/g, " ")}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      PRIORITY_BADGE[insight.priority] ??
                      "bg-zinc-100 text-zinc-700"
                    }`}
                  >
                    {insight.priority}
                  </span>
                </div>
                <div className="flex items-center gap-3 text-xs text-zinc-400">
                  <span>confidence: {(insight.confidence * 100).toFixed(0)}%</span>
                  <span>{new Date(insight.created_at).toLocaleDateString()}</span>
                </div>
              </div>

              {/* Content */}
              <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
                {insight.content}
              </p>

              {/* Affected departments */}
              {insight.affected_departments && insight.affected_departments.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-zinc-400">Departments:</span>
                  {insight.affected_departments.map((dept) => (
                    <span
                      key={dept}
                      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    >
                      {dept}
                    </span>
                  ))}
                </div>
              )}

              {/* Curator decision */}
              {insight.curator_reason && (
                <div className="text-xs rounded-md bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-2 text-zinc-600 dark:text-zinc-400">
                  <span className="font-medium text-zinc-700 dark:text-zinc-300">
                    Curator:
                  </span>{" "}
                  {insight.curator_reason}
                  {insight.decision_id && (
                    <>
                      {" · "}
                      <Link
                        href="/decisions"
                        className="underline hover:text-zinc-900 dark:hover:text-zinc-100"
                      >
                        view decision →
                      </Link>
                    </>
                  )}
                </div>
              )}

              {/* Override buttons */}
              <div className="flex gap-2 flex-wrap pt-1">
                {insight.status !== "actioned" && (
                  <button
                    onClick={() =>
                      override(insight.id, "actioned", "Manually promoted from inbox")
                    }
                    disabled={actingId === insight.id}
                    className="text-xs rounded-md border px-2.5 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50"
                  >
                    Promote to standing instruction
                  </button>
                )}
                {insight.status !== "dismissed" && (
                  <button
                    onClick={() =>
                      override(insight.id, "dismissed", "Manually dismissed from inbox")
                    }
                    disabled={actingId === insight.id}
                    className="text-xs rounded-md border px-2.5 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                )}
                {insight.status !== "acknowledged" && (
                  <button
                    onClick={() =>
                      override(insight.id, "acknowledged", "Manually acknowledged from inbox")
                    }
                    disabled={actingId === insight.id}
                    className="text-xs rounded-md border px-2.5 py-1 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50"
                  >
                    Acknowledge
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
