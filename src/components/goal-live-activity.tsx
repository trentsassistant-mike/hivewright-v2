"use client";

/**
 * GoalLiveActivity — real-time goal-level output viewer.
 *
 * Connects to GET /api/goals/:id/stream (SSE) and renders one terminal panel
 * per task seen in the stream. Tasks that start AFTER the page loads appear
 * automatically — no manual refresh needed.
 *
 * Handles:
 *   - Late-joining: server replays all task_logs for the goal on connect
 *   - Multiple tasks: one panel per taskId seen (sequential sprints work)
 *   - Per-task done state: panel shows "✓ done" when the task finishes
 *   - Reconnection: auto-retries after 3 s; deduplicates via seen-key set
 *
 * The key gap this closes: the goal view previously rendered LiveActivityPanel
 * only for tasks that were already "active" at server render time. This
 * component replaces that block and drives task panels entirely from the live
 * goal stream, so every task — past, present, or future — appears without a
 * page refresh.
 */

import { useEffect, useRef, useState } from "react";

interface GoalChunk {
  type: "connected" | "stdout" | "stderr" | "status" | "diagnostic" | "done";
  goalId?: string;
  taskId?: string;
  chunk?: string;
  id?: number;
  timestamp: string;
}

interface TaskPanelState {
  taskId: string;
  lines: Array<{ chunk: string; type: Exclude<GoalChunk["type"], "connected" | "done">; timestamp: string }>;
  done: boolean;
}

type ConnState = "connecting" | "connected" | "error";
const AUTO_SCROLL_THRESHOLD_PX = 80;

// ── Per-task terminal panel ───────────────────────────────────────────────────

function TaskOutputPanel({
  state,
  title,
}: {
  state: TaskPanelState;
  title: string;
}) {
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const output = outputRef.current;
    if (!output) return;
    const distanceFromBottom =
      output.scrollHeight - output.scrollTop - output.clientHeight;
    if (distanceFromBottom > AUTO_SCROLL_THRESHOLD_PX) return;
    output.scrollTop = output.scrollHeight;
  }, [state.lines]);

  const indicatorColor = state.done ? "text-zinc-500" : "text-green-400";
  const indicatorLabel = state.done ? "✓ done" : "● live";

  function lineColor(type: string) {
    if (type === "stderr") return "text-red-400";
    if (type === "status") return "text-yellow-300";
    if (type === "diagnostic") return "text-zinc-400";
    return "text-green-300";
  }

  function lineText(line: TaskPanelState["lines"][number]) {
    if (line.type !== "diagnostic") return line.chunk;
    try {
      const parsed = JSON.parse(line.chunk) as { kind?: unknown };
      return `runtime diagnostic: ${typeof parsed.kind === "string" ? parsed.kind : "unknown"}`;
    } catch {
      return "runtime diagnostic: unknown";
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-700">
      <div className="flex items-center justify-between border-b border-zinc-700 bg-zinc-900 px-4 py-2">
        <span className="truncate font-mono text-xs text-zinc-300">{title}</span>
        <span className={`ml-4 shrink-0 font-mono text-xs ${indicatorColor}`}>
          {indicatorLabel}
        </span>
      </div>
      <div
        ref={outputRef}
        data-testid={`goal-task-output-${state.taskId}`}
        className="max-h-80 overflow-y-auto bg-zinc-950 p-3 font-mono text-xs"
      >
        {state.lines.length === 0 ? (
          <p className="text-zinc-500">Waiting for output…</p>
        ) : (
          <div className="space-y-0.5">
            {state.lines.map((line, i) => (
              <div key={i} className="flex gap-2 leading-5">
                <span className="w-16 shrink-0 select-none text-zinc-600">
                  {new Date(line.timestamp).toLocaleTimeString("en-US", {
                    hour12: false,
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
                <span className={`break-all whitespace-pre-wrap ${lineColor(line.type)}`}>
                  {lineText(line)}
                </span>
              </div>
            ))}
            {state.done && <p className="pt-1 text-zinc-600">— end of output —</p>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Goal-level stream consumer ────────────────────────────────────────────────

export function GoalLiveActivity(props: {
  goalId: string;
  taskTitles?: Record<string, string>;
}) {
  return <GoalLiveActivityContent key={props.goalId} {...props} />;
}

function GoalLiveActivityContent({
  goalId,
  taskTitles,
}: {
  goalId: string;
  /** Map of taskId → human-readable title fetched server-side. Falls back to
   *  short UUID prefix for tasks that start after the initial page render. */
  taskTitles?: Record<string, string>;
}) {
  const [taskPanels, setTaskPanels] = useState<Map<string, TaskPanelState>>(
    new Map(),
  );
  const [connState, setConnState] = useState<ConnState>("connecting");
  const seenRef = useRef<Set<string>>(new Set());
  const destroyedRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    destroyedRef.current = false;
    seenRef.current = new Set();

    function connect() {
      if (destroyedRef.current) return;

      const es = new EventSource(`/api/goals/${goalId}/stream`);
      esRef.current = es;

      es.onmessage = (event: MessageEvent) => {
        try {
          const chunk = JSON.parse(event.data as string) as GoalChunk;

          if (chunk.type === "connected") {
            setConnState("connected");
            return;
          }

          if (!chunk.taskId) return;

          // Dedup by server-assigned bigserial id; fall back to composite key.
          const key =
            chunk.id !== undefined
              ? String(chunk.id)
              : `${chunk.taskId}::${chunk.timestamp}::${chunk.type}`;
          if (seenRef.current.has(key)) return;
          seenRef.current.add(key);

          const { taskId } = chunk;

          if (chunk.type === "done") {
            setTaskPanels((prev) => {
              const next = new Map(prev);
              const panel = next.get(taskId) ?? { taskId, lines: [], done: false };
              next.set(taskId, { ...panel, done: true });
              return next;
            });
            return;
          }
          if (
            chunk.type !== "stdout" &&
            chunk.type !== "stderr" &&
            chunk.type !== "status" &&
            chunk.type !== "diagnostic"
          ) {
            return;
          }
          const lineType = chunk.type;

          setTaskPanels((prev) => {
            const next = new Map(prev);
            const panel = next.get(taskId) ?? { taskId, lines: [], done: false };
            next.set(taskId, {
              ...panel,
              lines: [
                ...panel.lines,
                {
                  chunk: chunk.chunk ?? "",
                  type: lineType,
                  timestamp: chunk.timestamp,
                },
              ],
            });
            return next;
          });
        } catch {
          // Malformed frame — ignore
        }
      };

      es.onerror = () => {
        es.close();
        if (!destroyedRef.current) {
          setConnState("error");
          timerRef.current = setTimeout(connect, 3000);
        }
      };
    }

    connect();

    return () => {
      destroyedRef.current = true;
      esRef.current?.close();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [goalId]);

  const panels = Array.from(taskPanels.values());

  const globalIndicator =
    connState === "connected"
      ? { label: "● live", color: "text-green-400" }
      : connState === "error"
        ? { label: "⚠ reconnecting…", color: "text-red-400" }
        : { label: "○ connecting…", color: "text-yellow-400" };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold">Live Activity</h2>
          <span className="text-xs text-zinc-500">
            {panels.filter((p) => !p.done).length} active /{" "}
            {panels.length} total
          </span>
        </div>
        <span className={`font-mono text-xs ${globalIndicator.color}`}>
          {globalIndicator.label}
        </span>
      </div>
      {panels.length === 0 ? (
        <p className="text-sm text-zinc-500">
          {connState === "connecting"
            ? "Connecting…"
            : "No agent activity yet."}
        </p>
      ) : (
        <div className="space-y-3">
          {panels.map((panel) => (
            <TaskOutputPanel
              key={panel.taskId}
              state={panel}
              title={
                taskTitles?.[panel.taskId] ??
                `task:${panel.taskId.slice(0, 8)}`
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
