"use client";

import { useEffect, useState } from "react";
import { useHiveContext } from "@/components/hive-context";

type RoleMemoryFreshness = {
  role_slug: string;
  total: string;
  fresh: string;
  aging: string;
  stale: string;
};

type RecentEntry = {
  id: string;
  store: string;
  role_or_dept: string | null;
  content: string;
  updated_at: string;
};

const STORE_BADGE: Record<string, string> = {
  role_memory: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  hive_memory: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
};

function freshnessBar(fresh: string, aging: string, stale: string, total: string) {
  const t = parseInt(total, 10) || 1;
  const f = Math.round((parseInt(fresh, 10) / t) * 100);
  const a = Math.round((parseInt(aging, 10) / t) * 100);
  const s = Math.round((parseInt(stale, 10) / t) * 100);
  return { f, a, s };
}

export default function MemoryHealthPage() {
  const { selected, loading: bizLoading } = useHiveContext();
  const [byRole, setByRole] = useState<RoleMemoryFreshness[]>([]);
  const [hiveMemoryTotal, setHiveMemoryTotal] = useState<string>("0");
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;

    const fetchMemoryHealth = async () => {
      setLoading(true);
      try {
        // Fetch memory health data scoped to hive via API
        // Since there's no dedicated memory health API, we use the memory search API
        // and compute freshness client-side. For now, fetch recent entries.
        const url = new URL("/api/memory/search", window.location.origin);
        url.searchParams.set("hiveId", selected.id);

        const r = await fetch(url.toString());
        const body = await r.json();
        if (cancelled) return;
        const entries = body.data ?? [];

        // Compute role memory freshness from results
        const roleMap: Record<string, { total: number; fresh: number; aging: number; stale: number }> = {};
        const now = Date.now();
        const day30 = 30 * 24 * 60 * 60 * 1000;
        const day90 = 90 * 24 * 60 * 60 * 1000;

        let bizMemCount = 0;
        const recentEntries: RecentEntry[] = [];

        for (const entry of entries) {
          const age = now - new Date(entry.updated_at).getTime();

          if (entry.store === "role_memory") {
            const slug = entry.role_slug || "unknown";
            if (!roleMap[slug]) roleMap[slug] = { total: 0, fresh: 0, aging: 0, stale: 0 };
            roleMap[slug].total++;
            if (age < day30) roleMap[slug].fresh++;
            else if (age < day90) roleMap[slug].aging++;
            else roleMap[slug].stale++;
          } else if (entry.store === "hive_memory") {
            bizMemCount++;
          }

          if (recentEntries.length < 10) {
            recentEntries.push({
              id: entry.id,
              store: entry.store,
              role_or_dept: entry.role_slug || entry.department || null,
              content: entry.content,
              updated_at: entry.updated_at,
            });
          }
        }

        setByRole(
          Object.entries(roleMap)
            .map(([role_slug, counts]) => ({
              role_slug,
              total: String(counts.total),
              fresh: String(counts.fresh),
              aging: String(counts.aging),
              stale: String(counts.stale),
            }))
            .sort((a, b) => parseInt(b.total, 10) - parseInt(a.total, 10))
        );
        setHiveMemoryTotal(String(bizMemCount));
        setRecent(recentEntries);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchMemoryHealth();
    return () => { cancelled = true; };
  }, [selected]);

  if (bizLoading) return <p className="text-zinc-400">Loading...</p>;
  if (!selected) return <p className="text-zinc-400">No hive selected.</p>;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Memory Health</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Freshness and coverage across role and hive memory stores for {selected.name}.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-zinc-400">Loading memory health data...</p>
      ) : (
        <>
          {/* Role memory by freshness */}
          <section>
            <h2 className="text-lg font-medium mb-3">Role Memory Freshness</h2>
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 dark:bg-zinc-900">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-zinc-500">Role</th>
                    <th className="px-4 py-3 text-right font-medium text-zinc-500">Total</th>
                    <th className="px-4 py-3 text-right font-medium text-zinc-500 text-green-600">Fresh (&lt;30d)</th>
                    <th className="px-4 py-3 text-right font-medium text-zinc-500 text-yellow-600">Aging (30-90d)</th>
                    <th className="px-4 py-3 text-right font-medium text-zinc-500 text-red-600">Stale (&gt;90d)</th>
                    <th className="px-4 py-3 text-left font-medium text-zinc-500">Distribution</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {byRole.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                        No role memory entries yet.
                      </td>
                    </tr>
                  ) : (
                    byRole.map((row) => {
                      const { f, a, s } = freshnessBar(row.fresh, row.aging, row.stale, row.total);
                      return (
                        <tr key={row.role_slug} className="hover:bg-zinc-50 dark:hover:bg-zinc-900">
                          <td className="px-4 py-3 font-medium text-zinc-800 dark:text-zinc-200">
                            {row.role_slug}
                          </td>
                          <td className="px-4 py-3 text-right text-zinc-600 dark:text-zinc-400">
                            {row.total}
                          </td>
                          <td className="px-4 py-3 text-right text-green-700 dark:text-green-400">
                            {row.fresh}
                          </td>
                          <td className="px-4 py-3 text-right text-yellow-700 dark:text-yellow-400">
                            {row.aging}
                          </td>
                          <td className="px-4 py-3 text-right text-red-700 dark:text-red-400">
                            {row.stale}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex h-2 w-32 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                              {f > 0 && (
                                <div className="bg-green-500" style={{ width: `${f}%` }} title={`Fresh: ${f}%`} />
                              )}
                              {a > 0 && (
                                <div className="bg-yellow-400" style={{ width: `${a}%` }} title={`Aging: ${a}%`} />
                              )}
                              {s > 0 && (
                                <div className="bg-red-500" style={{ width: `${s}%` }} title={`Stale: ${s}%`} />
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Hive memory count */}
          <section>
            <h2 className="text-lg font-medium mb-3">Hive Memory</h2>
            <div className="rounded-lg border p-4">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {selected.name} has <span className="font-medium">{hiveMemoryTotal}</span> active hive memory entries.
              </p>
            </div>
          </section>

          {/* Recent additions */}
          <section>
            <h2 className="text-lg font-medium mb-3">Recent Additions</h2>
            <div className="space-y-2">
              {recent.length === 0 ? (
                <div className="rounded-lg border border-dashed p-8 text-center text-zinc-500 text-sm">
                  No memory entries yet.
                </div>
              ) : (
                recent.map((entry) => (
                  <div key={`${entry.store}-${entry.id}`} className="rounded-lg border p-4 space-y-2">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            STORE_BADGE[entry.store] ?? "bg-zinc-100 text-zinc-800"
                          }`}
                        >
                          {entry.store.replace("_", " ")}
                        </span>
                        {entry.role_or_dept && (
                          <span className="text-xs text-zinc-500">{entry.role_or_dept}</span>
                        )}
                      </div>
                      <span className="text-xs text-zinc-400">
                        {new Date(entry.updated_at).toLocaleDateString()}
                      </span>
                    </div>
                    <p className="text-sm text-zinc-700 dark:text-zinc-300 line-clamp-2">
                      {entry.content}
                    </p>
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
