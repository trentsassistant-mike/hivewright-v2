"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { RunsTable, type RunsTableRow } from "@/components/runs-table";

interface Hive { id: string; name: string; slug: string; type: string; }

export default function HivesPage() {
  const [hives, setHives] = useState<Hive[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/hives").then(r => r.json()).then(b => setHives(b.data || [])).finally(() => setLoading(false));
  }, []);

  const rows: RunsTableRow[] = hives.map((hive) => ({
    id: hive.id,
    title: hive.name,
    href: `/hives/${hive.id}`,
    status: { label: hive.type, tone: "neutral" },
    primaryMeta: [{ label: "Slug", value: <span className="font-mono">{hive.slug}</span> }],
    secondaryMeta: [{ label: "ID", value: <span className="font-mono">{hive.id.slice(0, 8)}</span> }],
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Hives</h1>
        <Link href="/hives/new"
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200">
          + New Hive
        </Link>
      </div>
      <RunsTable
        rows={rows}
        loading={loading}
        loadingState="Loading..."
        emptyState='No hives yet. Click "New Hive" to get started.'
        ariaLabel="Hives list"
        columns={{ title: "Hive", primaryMeta: "Slug", status: "Type", priority: "", secondaryMeta: "ID" }}
      />
    </div>
  );
}
