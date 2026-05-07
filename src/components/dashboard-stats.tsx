"use client";

import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";

interface Summary {
  agentsEnabled: number;
  tasksInProgress: number;
  monthSpendCents: number;
  pendingApprovals: number;
}

async function fetchSummary(hiveId: string): Promise<Summary> {
  const res = await fetch(`/api/dashboard/summary?hiveId=${hiveId}`);
  if (!res.ok) throw new Error(`summary failed: ${res.status}`);
  return (await res.json()) as Summary;
}

function formatCents(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}

export function DashboardStats({ hiveId }: { hiveId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.dashboard.summary(hiveId),
    queryFn: () => fetchSummary(hiveId),
  });

  const cells: { label: string; value: string }[] = [
    { label: "Agents Enabled", value: isLoading || !data ? "—" : String(data.agentsEnabled) },
    { label: "Tasks In Progress", value: isLoading || !data ? "—" : String(data.tasksInProgress) },
    { label: "Month Spend", value: isLoading || !data ? "—" : formatCents(data.monthSpendCents) },
    { label: "Pending Approvals", value: isLoading || !data ? "—" : String(data.pendingApprovals) },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {cells.map((cell) => (
        <div key={cell.label} className="rounded-lg border border-amber-200/60 bg-card p-4 dark:border-amber-800/30">
          <p className="text-2xl font-semibold">{cell.value}</p>
          <p className="text-sm text-amber-700/60 dark:text-amber-400/50">{cell.label}</p>
        </div>
      ))}
    </div>
  );
}
