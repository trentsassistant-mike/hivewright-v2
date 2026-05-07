"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { AgentCard } from "./agent-card";

interface ActiveTask {
  id: string;
  title: string;
  assignedTo: string;
  createdBy: string | null;
  status: string;
  parentTaskId: string | null;
  goalId: string | null;
  goalTitle: string | null;
  adapterType: string | null;
  startedAt: string | null;
  createdAt: string;
  updatedAt: string;
  modelUsed: string | null;
}

async function fetchActiveTasks(hiveId: string): Promise<ActiveTask[]> {
  const res = await fetch(`/api/active-tasks?hiveId=${hiveId}`);
  if (!res.ok) throw new Error(`active-tasks failed: ${res.status}`);
  const body = (await res.json()) as { tasks: ActiveTask[] };
  return body.tasks;
}

export function ActiveAgentGrid({ hiveId }: { hiveId: string }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.tasks.active(hiveId),
    queryFn: () => fetchActiveTasks(hiveId),
  });

  const handleCancelled = (taskId: string) => {
    // Optimistically remove then schedule a background refetch.
    queryClient.setQueryData<ActiveTask[]>(
      queryKeys.tasks.active(hiveId),
      (prev) => prev?.filter((t) => t.id !== taskId) ?? [],
    );
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.active(hiveId) });
  };

  if (isLoading) {
    return <p className="text-[13px] text-muted-foreground">Loading agents…</p>;
  }
  if (error) {
    return <p className="text-[13px] text-[#D4A398]">Failed to load active tasks.</p>;
  }
  if (!data || data.length === 0) {
    return (
      <div className="rounded-[12px] border border-dashed border-honey-700/40 bg-[#0F1114] p-8 text-center text-[13px] text-muted-foreground">
        No agents are currently running. Create a task to see them here.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {data.map((task) => (
        <AgentCard
          key={task.id}
          taskId={task.id}
          assignedTo={task.assignedTo}
          title={task.title}
          modelUsed={task.modelUsed}
          createdBy={task.createdBy}
          status={task.status}
          parentTaskId={task.parentTaskId}
          goalId={task.goalId}
          goalTitle={task.goalTitle}
          adapterType={task.adapterType}
          createdAt={task.createdAt}
          updatedAt={task.updatedAt}
          onCancelled={handleCancelled}
        />
      ))}
    </div>
  );
}
