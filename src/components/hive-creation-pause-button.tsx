"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";

type HiveCreationPause = {
  paused: boolean;
  reason: string | null;
  pausedBy: string | null;
  updatedAt: string | null;
};

async function fetchCreationPause(hiveId: string): Promise<HiveCreationPause> {
  const res = await fetch(`/api/hives/${hiveId}/creation-pause`);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? "Failed to load hive pause state");
  return body.data;
}

async function setCreationPause(input: {
  hiveId: string;
  paused: boolean;
  reason?: string;
}): Promise<HiveCreationPause> {
  const res = await fetch(`/api/hives/${input.hiveId}/creation-pause`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paused: input.paused,
      reason: input.reason,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? "Failed to update hive pause state");
  return body.data;
}

export function HiveCreationPauseButton({ hiveId }: { hiveId: string }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["hive-creation-pause", hiveId],
    queryFn: () => fetchCreationPause(hiveId),
    refetchInterval: 30_000,
  });
  const mutation = useMutation({
    mutationFn: setCreationPause,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["hive-creation-pause", hiveId] }),
        queryClient.invalidateQueries({ queryKey: ["brief", hiveId] }),
      ]);
    },
  });

  const paused = data?.paused ?? false;
  const busy = mutation.isPending;

  return (
    <Button
      type="button"
      size="sm"
      variant={paused ? "outline" : "destructive"}
      disabled={busy}
      title={data?.reason ?? undefined}
      onClick={() => {
        mutation.mutate({
          hiveId,
          paused: !paused,
          reason: paused ? undefined : "Paused from dashboard",
        });
      }}
    >
      {paused ? (
        <Play className="size-3.5" aria-hidden="true" />
      ) : (
        <Pause className="size-3.5" aria-hidden="true" />
      )}
      {paused ? "Resume work" : "Pause Hive"}
    </Button>
  );
}
