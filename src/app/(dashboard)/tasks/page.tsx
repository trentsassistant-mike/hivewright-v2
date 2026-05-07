"use client";

import { useEffect, useState } from "react";
import { useHiveContext } from "@/components/hive-context";
import { RunsTable, type RunsTableBadgeTone, type RunsTableRow } from "@/components/runs-table";

const STATUS_FILTERS = ["all", "pending", "active", "completed", "failed"] as const;

const STATUS_TONE: Record<string, RunsTableBadgeTone> = {
  pending: "amber",
  active: "amber",
  completed: "green",
  failed: "red",
};

type TaskRow = {
  id: string;
  title: string;
  assignedTo: string;
  status: string;
  priority: number;
  createdAt: string;
};

export default function TasksPage() {
  const { selected, loading: bizLoading } = useHiveContext();
  const [activeFilter, setActiveFilter] = useState<string>("all");
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;

    const fetchTasks = async () => {
      setLoading(true);
      setError(null);
      try {
        const url = new URL("/api/tasks", window.location.origin);
        url.searchParams.set("hiveId", selected.id);
        if (activeFilter !== "all") url.searchParams.set("status", activeFilter);
        const r = await fetch(url.toString());
        if (!r.ok) throw new Error(`Request failed with ${r.status}`);
        const body = await r.json();
        if (!cancelled) setTasks(body.data || []);
      } catch (err) {
        if (!cancelled) {
          setTasks([]);
          setError(err instanceof Error ? err.message : "Unable to load tasks.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchTasks();
    return () => { cancelled = true; };
  }, [selected, activeFilter]);

  if (bizLoading) return <p className="text-zinc-400">Loading...</p>;
  if (!selected) return <p className="text-zinc-400">No hive selected.</p>;

  const rows: RunsTableRow[] = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    href: `/tasks/${task.id}`,
    status: { label: task.status, tone: STATUS_TONE[task.status] ?? "neutral" },
    priority: {
      label: task.priority,
      tone: task.priority <= 2 ? "red" : "neutral",
      title: `Priority ${task.priority}`,
    },
    primaryMeta: [{ label: "Role", value: task.assignedTo }],
    secondaryMeta: [{ label: "Created", value: new Date(task.createdAt).toLocaleDateString() }],
  }));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Tasks</h1>

      {/* Status filter tabs */}
      <div className="-mx-4 flex gap-2 overflow-x-auto border-b px-4 pb-2 sm:mx-0 sm:px-0">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setActiveFilter(f)}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm capitalize transition-colors ${
              activeFilter === f
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      <RunsTable
        rows={rows}
        loading={loading}
        error={error ? `Unable to load tasks. ${error}` : null}
        loadingState="Loading tasks..."
        emptyState="No tasks found."
      />
    </div>
  );
}
