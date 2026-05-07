"use client";

import { useState } from "react";
import { useHiveContext } from "@/components/hive-context";
import { RunsTable, type RunsTableBadgeTone, type RunsTableRow } from "@/components/runs-table";

type MemoryResult = {
  id: string;
  store: "role_memory" | "hive_memory" | "insights";
  content: string;
  confidence: number | null;
  sensitivity: string | null;
  updated_at: string;
};

const STORE_TONE: Record<string, RunsTableBadgeTone> = {
  role_memory: "blue",
  hive_memory: "blue",
  insights: "amber",
};

export default function MemoryPage() {
  const { selected, loading: bizLoading } = useHiveContext();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MemoryResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;

    setLoading(true);
    setError(null);
    setSearched(false);

    try {
      const url = new URL("/api/memory/search", window.location.origin);
      url.searchParams.set("hiveId", selected.id);
      if (query.trim()) url.searchParams.set("q", query.trim());

      const res = await fetch(url.toString());
      if (!res.ok) throw new Error("Search failed");

      const data = await res.json();
      setResults(data.data ?? []);
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  if (bizLoading) return <p className="text-zinc-400">Loading...</p>;
  if (!selected) return <p className="text-zinc-400">No hive selected.</p>;

  const rows: RunsTableRow[] = results.map((item) => ({
    id: item.id,
    title: item.content,
    status: {
      label: item.store.replace("_", " "),
      tone: STORE_TONE[item.store] ?? "neutral",
    },
    primaryMeta: [
      {
        label: "Sensitivity",
        value: item.sensitivity ?? "standard",
      },
    ],
    secondaryMeta: [
      ...(item.confidence !== null
        ? [{ label: "Confidence", value: `${(item.confidence * 100).toFixed(0)}%` }]
        : []),
      { label: "Updated", value: new Date(item.updated_at).toLocaleDateString() },
    ],
    expandedContent: (
      <p className="text-sm whitespace-pre-wrap text-zinc-700 dark:text-zinc-300">{item.content}</p>
    ),
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Memory Search</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Search across role memory, hive memory, and insights.
        </p>
      </div>

      <form onSubmit={handleSearch} className="flex gap-3 items-end flex-wrap">
        {/* Search input */}
        <div className="flex-1 min-w-48 space-y-1">
          <label htmlFor="query" className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Search
          </label>
          <input
            id="query"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Leave blank to show all..."
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder-zinc-500"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {loading ? "Searching..." : "Search"}
        </button>
      </form>

      {/* Error */}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Results */}
      {searched && (
        <div className="space-y-3">
          <p className="text-sm text-zinc-500">{results.length} result{results.length !== 1 ? "s" : ""}</p>

          <RunsTable
            rows={rows}
            emptyState="No memory entries found."
            ariaLabel="Memory entries"
            columns={{
              title: "Entry",
              primaryMeta: "Sensitivity",
              status: "Store",
              priority: "",
              secondaryMeta: "Signals",
            }}
          />
        </div>
      )}
    </div>
  );
}
