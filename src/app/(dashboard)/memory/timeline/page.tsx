"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useHiveContext } from "@/components/hive-context";

type TimelineEntry = {
  id: string;
  store: string;
  content: string;
  confidence: number;
  sensitivity: string;
  role_slug: string | null;
  category: string | null;
  connection_type: string | null;
  source_task_id: string | null;
  created_at: string;
};

const STORE_TABS = [
  { value: "", label: "All" },
  { value: "role_memory", label: "Role Memory" },
  { value: "hive_memory", label: "Hive Memory" },
  { value: "insights", label: "Insights" },
] as const;

const STORE_BADGE: Record<string, string> = {
  role_memory:
    "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  hive_memory:
    "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  insights:
    "bg-amber-100 text-amber-800 dark:bg-amber-400/10 dark:text-amber-200 dark:ring-1 dark:ring-inset dark:ring-amber-400/20",
};

const SENSITIVITY_BADGE: Record<string, string> = {
  public: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  internal: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  confidential:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  restricted: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

const PAGE_SIZE = 25;

export default function MemoryTimelinePage() {
  const { selected, loading: bizLoading } = useHiveContext();
  const [store, setStore] = useState("");
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTimeline = useCallback(
    async (storeFilter: string, pageOffset: number) => {
      if (!selected) return;
      setLoading(true);
      setError(null);
      try {
        const url = new URL("/api/memory/timeline", window.location.origin);
        url.searchParams.set("hiveId", selected.id);
        url.searchParams.set("limit", String(PAGE_SIZE));
        url.searchParams.set("offset", String(pageOffset));
        if (storeFilter) url.searchParams.set("store", storeFilter);

        const res = await fetch(url.toString());
        if (!res.ok) throw new Error("Failed to fetch timeline");
        const body = await res.json();
        setEntries(body.data ?? []);
        setTotal(body.total ?? 0);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    },
    [selected],
  );

  useEffect(() => {
    setOffset(0);
    fetchTimeline(store, 0);
  }, [selected, store, fetchTimeline]);

  function handlePrev() {
    const newOffset = Math.max(0, offset - PAGE_SIZE);
    setOffset(newOffset);
    fetchTimeline(store, newOffset);
  }

  function handleNext() {
    const newOffset = offset + PAGE_SIZE;
    setOffset(newOffset);
    fetchTimeline(store, newOffset);
  }

  if (bizLoading) return <p className="text-zinc-400">Loading...</p>;
  if (!selected)
    return <p className="text-zinc-400">No hive selected.</p>;

  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Memory Timeline</h1>
        <p className="mt-1 text-sm text-zinc-500">
          What was learned, when, and from which tasks -- across all memory
          stores for {selected.name}.
        </p>
      </div>

      {/* Store filter tabs */}
      <div className="flex gap-1">
        {STORE_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setStore(tab.value)}
            className={`rounded-md px-3 py-2 text-sm transition-colors ${
              store === tab.value
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "border text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Timeline entries */}
      {loading ? (
        <div className="text-sm text-zinc-500">Loading timeline...</div>
      ) : entries.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-zinc-500">
          No memory entries found.
        </div>
      ) : (
        <>
          <p className="text-sm text-zinc-500">
            Showing {offset + 1}--{Math.min(offset + PAGE_SIZE, total)} of{" "}
            {total} entries
          </p>
          <div className="space-y-3">
            {entries.map((entry) => (
              <div
                key={`${entry.store}-${entry.id}`}
                className="rounded-lg border p-4 space-y-2"
              >
                {/* Header row */}
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        STORE_BADGE[entry.store] ??
                        "bg-zinc-100 text-zinc-800"
                      }`}
                    >
                      {entry.store.replace(/_/g, " ")}
                    </span>
                    {entry.sensitivity && (
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          SENSITIVITY_BADGE[entry.sensitivity] ??
                          "bg-zinc-100 text-zinc-700"
                        }`}
                      >
                        {entry.sensitivity}
                      </span>
                    )}
                    {entry.role_slug && (
                      <span className="text-xs text-zinc-500">
                        role: {entry.role_slug}
                      </span>
                    )}
                    {entry.category && (
                      <span className="text-xs text-zinc-500">
                        category: {entry.category}
                      </span>
                    )}
                    {entry.connection_type && (
                      <span className="text-xs text-zinc-500">
                        {entry.connection_type.replace(/_/g, " ")}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-zinc-400">
                    <span>
                      confidence: {(entry.confidence * 100).toFixed(0)}%
                    </span>
                    <span>
                      {new Date(entry.created_at).toLocaleDateString()}{" "}
                      {new Date(entry.created_at).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                </div>

                {/* Content */}
                <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
                  {entry.content}
                </p>

                {/* Source task link */}
                {entry.source_task_id && (
                  <div className="pt-1">
                    <Link
                      href={`/tasks?id=${entry.source_task_id}`}
                      className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                    >
                      Source task: {entry.source_task_id.slice(0, 8)}...
                    </Link>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <button
                onClick={handlePrev}
                disabled={offset === 0}
                className="rounded-md border px-4 py-2 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                Previous
              </button>
              <span className="text-sm text-zinc-500">
                Page {currentPage} of {totalPages}
              </span>
              <button
                onClick={handleNext}
                disabled={offset + PAGE_SIZE >= total}
                className="rounded-md border px-4 py-2 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
