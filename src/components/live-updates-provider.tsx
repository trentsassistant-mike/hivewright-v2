"use client";

import { useEffect, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";

interface LiveEvent {
  type: string;
  taskId?: string;
  decisionId?: string;
  threadId?: string;
  messageId?: string;
  hiveId?: string;
  timestamp?: string;
}

export function LiveUpdatesProvider({
  hiveId,
  children,
}: {
  hiveId: string;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!hiveId) return;
    const es = new EventSource(`/api/events?hiveId=${hiveId}`);

    es.onmessage = (event) => {
      let parsed: LiveEvent;
      try {
        parsed = JSON.parse(event.data) as LiveEvent;
      } catch {
        return;
      }
      if (!parsed.type || parsed.type === "connected") return;

      switch (parsed.type) {
        case "task_created":
        case "task_claimed":
        case "task_completed":
        case "task_failed":
        case "task_cancelled": {
          queryClient.invalidateQueries({
            queryKey: queryKeys.dashboard.summary(hiveId),
          });
          queryClient.invalidateQueries({
            queryKey: queryKeys.tasks.active(hiveId),
          });
          queryClient.invalidateQueries({ queryKey: ["brief", hiveId] });
          queryClient.invalidateQueries({ queryKey: ["operations-map", "active-tasks", hiveId] });
          queryClient.invalidateQueries({ queryKey: ["operations-map", "critical-items", hiveId] });
          queryClient.invalidateQueries({ queryKey: ["operations-map", "active-supervisors", hiveId] });
          queryClient.invalidateQueries({ queryKey: ["supervisor-reports", hiveId] });
          if (parsed.taskId) {
            queryClient.invalidateQueries({
              queryKey: queryKeys.tasks.detail(parsed.taskId),
            });
          }
          break;
        }
        case "decision_created":
        case "decision_resolved": {
          queryClient.invalidateQueries({
            queryKey: queryKeys.decisions.list(hiveId),
          });
          queryClient.invalidateQueries({
            queryKey: queryKeys.dashboard.summary(hiveId),
          });
          queryClient.invalidateQueries({ queryKey: ["brief", hiveId] });
          queryClient.invalidateQueries({ queryKey: ["operations-map", "critical-items", hiveId] });
          break;
        }
        case "ea_message_created":
        case "ea_message_updated":
        case "ea_turn_failed": {
          queryClient.invalidateQueries({
            queryKey: queryKeys.eaChat.active(hiveId),
          });
          break;
        }
        default:
          break;
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects on transient errors. Nothing to do.
    };

    return () => {
      es.close();
    };
  }, [hiveId, queryClient]);

  return <>{children}</>;
}
