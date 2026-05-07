"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useHiveContext } from "@/components/hive-context";
import { RunsTable, type RunsTableBadgeTone, type RunsTableRow } from "@/components/runs-table";

const STATUS_TONE: Record<string, RunsTableBadgeTone> = {
  pending: "amber",
  active: "amber",
  achieved: "green",
  completed: "green",
  cancelled: "neutral",
  failed: "red",
  paused: "neutral",
};

const TERMINAL_STATUSES = new Set(["achieved", "completed", "cancelled", "failed"]);
const CANCELLABLE_STATUSES = new Set(["active", "paused", "achieved"]);

type GoalRow = {
  id: string;
  title: string;
  status: string;
  budgetCents: number | null;
  spentCents: number;
  createdAt: string;
  archivedAt: string | null;
  totalTasks?: number;
  completedTasks?: number;
};

function GoalsPageInner() {
  const { selected, loading: bizLoading } = useHiveContext();
  const searchParams = useSearchParams();
  const router = useRouter();
  const showArchived = searchParams.get("showArchived") === "1";
  const [goals, setGoals] = useState<GoalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;

    const fetchGoals = async () => {
      setLoading(true);
      try {
        const url = `/api/goals?hiveId=${selected.id}${showArchived ? "&includeArchived=1" : ""}`;
        const r = await fetch(url);
        const body = await r.json();
        if (!cancelled) setGoals(body.data || []);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchGoals();
    return () => { cancelled = true; };
  }, [selected, showArchived]);

  function toggleShowArchived() {
    const params = new URLSearchParams(searchParams.toString());
    if (showArchived) params.delete("showArchived");
    else params.set("showArchived", "1");
    router.replace(`/goals${params.size ? `?${params.toString()}` : ""}`);
  }

  async function postAction(goalId: string, action: "cancel" | "archive" | "unarchive") {
    const body = action === "cancel" ? JSON.stringify({}) : undefined;
    const r = await fetch(`/api/goals/${goalId}/${action}`, {
      method: "POST",
      headers: action === "cancel" ? { "content-type": "application/json" } : undefined,
      body,
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: "Request failed" }));
      window.alert(err.error ?? "Request failed");
      return;
    }
    setOpenMenuId(null);
    if (selected) {
      const url = `/api/goals?hiveId=${selected.id}${showArchived ? "&includeArchived=1" : ""}`;
      const refreshed = await fetch(url);
      const body = await refreshed.json();
      setGoals(body.data || []);
    }
  }

  function onCancel(goal: GoalRow) {
    if (!window.confirm(`Cancel goal "${goal.title}"? This will archive it.`)) return;
    postAction(goal.id, "cancel");
  }

  if (bizLoading) return <p className="text-zinc-400">Loading...</p>;
  if (!selected) return <p className="text-zinc-400">No hive selected.</p>;

  const rows: RunsTableRow[] = goals.map((goal) => {
    const total = goal.totalTasks ?? 0;
    const completed = goal.completedTasks ?? 0;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    const budgetDisplay =
      goal.budgetCents !== null
        ? `$${((goal.spentCents ?? 0) / 100).toFixed(2)} / $${(goal.budgetCents / 100).toFixed(2)}`
        : null;
    const isTerminal = TERMINAL_STATUSES.has(goal.status);
    const isArchived = goal.archivedAt !== null;
    const isCancellable = CANCELLABLE_STATUSES.has(goal.status);

    return {
      id: goal.id,
      title: goal.title,
      href: `/goals/${goal.id}`,
      status: {
        label: isArchived ? `${goal.status} / archived` : goal.status,
        tone: isArchived ? "neutral" : STATUS_TONE[goal.status] ?? "neutral",
      },
      primaryMeta: [{ label: "Tasks", value: `${completed}/${total}` }],
      secondaryMeta: [{ label: "Created", value: new Date(goal.createdAt).toLocaleDateString() }],
      muted: isArchived,
      actions: (
        <div className="relative inline-flex">
          <button
            type="button"
            className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-amber-100 dark:text-zinc-400 dark:hover:bg-white/[0.08]"
            onClick={() => setOpenMenuId(openMenuId === goal.id ? null : goal.id)}
          >
            ...
          </button>
          {openMenuId === goal.id && (
            <div className="absolute right-0 top-full z-10 mt-1 w-40 rounded-md border border-zinc-700 bg-zinc-900 shadow-lg">
              {isCancellable && (
                <button
                  type="button"
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-800"
                  onClick={() => onCancel(goal)}
                >
                  Cancel
                </button>
              )}
              {!isArchived && (
                <button
                  type="button"
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-800"
                  onClick={() => postAction(goal.id, "archive")}
                >
                  Archive
                </button>
              )}
              {isArchived && (
                <button
                  type="button"
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-zinc-800"
                  onClick={() => postAction(goal.id, "unarchive")}
                >
                  Unarchive
                </button>
              )}
            </div>
          )}
        </div>
      ),
      expandedContent: (
        <div className="space-y-1">
          {!isTerminal && (
            <>
              <div className="flex justify-between text-xs text-zinc-500">
                <span>
                  {completed}/{total} tasks
                </span>
                {budgetDisplay && <span>{budgetDisplay}</span>}
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                <div
                  className="h-full rounded-full bg-amber-500 transition-all dark:bg-amber-400"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </>
          )}
          {isTerminal && budgetDisplay && (
            <div className="text-xs text-zinc-500">{budgetDisplay}</div>
          )}
        </div>
      ),
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Goals</h1>
        <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={toggleShowArchived}
            className="h-4 w-4"
          />
          Show archived
        </label>
      </div>

      <RunsTable
        rows={rows}
        loading={loading}
        loadingState="Loading goals..."
        emptyState="No goals yet."
        ariaLabel="Goals list"
        columns={{ title: "Goal", primaryMeta: "Tasks", priority: "", secondaryMeta: "Created" }}
      />
    </div>
  );
}

export default function GoalsPage() {
  return (
    <Suspense fallback={<p className="text-zinc-400">Loading...</p>}>
      <GoalsPageInner />
    </Suspense>
  );
}
