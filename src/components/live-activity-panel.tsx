"use client";

/**
 * LiveActivityPanel — real-time agent output viewer.
 *
 * Connects to GET /api/tasks/:id/stream (SSE) and renders adapter output as
 * a compact terminal-style panel. Handles:
 *   - Late-joining: server replays buffered chunks on connect
 *   - Reconnection: auto-retries after 3 s; deduplicates replayed chunks via
 *     a seen-key set so no line appears twice
 *   - States: connecting → connected (live) → done; error triggers reconnect
 *   - Status-aware empty states (pending vs active vs finished)
 */

import { useEffect, useRef, useState } from "react";
import { shapeAgentChunk } from "./utils/agent-chunk";

interface OutputChunk {
  taskId: string;
  chunk: string;
  type: "stdout" | "stderr" | "status" | "diagnostic" | "done" | "connected";
  /** Server-assigned bigserial id. Present on all log events; absent on "connected". */
  id?: number;
  timestamp: string;
}

type ConnectionState = "connecting" | "connected" | "error" | "done";
const AUTO_SCROLL_THRESHOLD_PX = 80;

export interface LiveActivityPanelProps {
  taskId: string;
  taskTitle?: string;
  /** Pass task status from server to drive empty-state messaging */
  taskStatus?: "pending" | "active" | "completed" | "failed";
}

export function LiveActivityPanel(props: LiveActivityPanelProps) {
  return <LiveActivityPanelContent key={props.taskId} {...props} />;
}

function LiveActivityPanelContent({ taskId, taskTitle, taskStatus }: LiveActivityPanelProps) {
  const [lines, setLines] = useState<OutputChunk[]>([]);
  const [connState, setConnState] = useState<ConnectionState>("connecting");
  const outputRef = useRef<HTMLDivElement>(null);
  // Keys for deduplication: timestamp::type::content-prefix
  const seenRef = useRef<Set<string>>(new Set());
  const destroyedRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    destroyedRef.current = false;
    seenRef.current = new Set();

    function connect() {
      if (destroyedRef.current) return;

      const es = new EventSource(`/api/tasks/${taskId}/stream`);
      esRef.current = es;

      es.onmessage = (event: MessageEvent) => {
        try {
          const chunk = JSON.parse(event.data as string) as OutputChunk;

          if (chunk.type === "connected") {
            setConnState("connected");
            return;
          }

          // Dedup: use server-assigned id when present (unique per task);
          // fall back to timestamp composite for the "connected" event which has no id.
          const key = chunk.id !== undefined
            ? String(chunk.id)
            : `${chunk.timestamp}::${chunk.type}::${chunk.chunk.slice(0, 120)}`;
          if (seenRef.current.has(key)) return;
          seenRef.current.add(key);

          if (chunk.type === "done") {
            setConnState("done");
            es.close();
            return;
          }

          setLines((prev) => [...prev, chunk]);
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
  }, [taskId]);

  // Keep the output pinned only while the reader is already following the tail.
  useEffect(() => {
    const output = outputRef.current;
    if (!output) return;
    const distanceFromBottom =
      output.scrollHeight - output.scrollTop - output.clientHeight;
    if (distanceFromBottom > AUTO_SCROLL_THRESHOLD_PX) return;
    output.scrollTop = output.scrollHeight;
  }, [lines]);

  function lineColor(type: OutputChunk["type"]) {
    if (type === "stderr") return "text-red-400";
    if (type === "status") return "text-yellow-300";
    if (type === "diagnostic") return "text-zinc-400";
    return "text-green-300";
  }

  function lineDisplay(line: OutputChunk) {
    if (line.type !== "diagnostic") return shapeAgentChunk(line.chunk);
    try {
      const parsed = JSON.parse(line.chunk) as { kind?: unknown };
      return {
        display: `runtime diagnostic: ${typeof parsed.kind === "string" ? parsed.kind : "unknown"}`,
        summarised: false,
        originalBytes: line.chunk.length,
      };
    } catch {
      return {
        display: "runtime diagnostic: unknown",
        summarised: false,
        originalBytes: line.chunk.length,
      };
    }
  }

  function emptyMessage() {
    if (connState === "connecting") return "Connecting to agent output…";
    if (connState === "error") return "Connection lost. Reconnecting…";
    if (connState === "done") return "No output recorded.";
    // connected + no lines
    if (taskStatus === "completed" || taskStatus === "failed") return "No output buffered.";
    if (taskStatus === "pending") return "Task has not started yet.";
    return "Waiting for agent output…";
  }

  const indicatorColor =
    connState === "connected" ? "text-green-400" :
    connState === "done" ? "text-zinc-500" :
    connState === "error" ? "text-red-400" :
    "text-yellow-400";

  const indicatorLabel =
    connState === "connected" ? "● live" :
    connState === "done" ? "✓ done" :
    connState === "error" ? "⚠ reconnecting…" :
    "○ connecting…";

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-700">
      {/* Terminal chrome */}
      <div className="flex items-center justify-between border-b border-zinc-700 bg-zinc-900 px-4 py-2">
        <span className="truncate font-mono text-xs text-zinc-300">
          {taskTitle ?? `task:${taskId.slice(0, 8)}`}
        </span>
        <span className={`ml-4 shrink-0 font-mono text-xs ${indicatorColor}`}>
          {indicatorLabel}
        </span>
      </div>

      {/* Output body */}
      <div className="max-h-80 overflow-y-auto bg-zinc-950 p-3 font-mono text-xs" ref={outputRef}>
        {lines.length === 0 ? (
          <p className={connState === "error" ? "text-red-400" : "text-zinc-500"}>
            {emptyMessage()}
          </p>
        ) : (
          <div className="space-y-0.5">
            {lines.map((line, i) => (
              (() => {
                const display = lineDisplay(line);
                return (
                  <div key={i} className="flex gap-2 leading-5">
                    <span className="w-16 shrink-0 select-none text-zinc-600">
                      {new Date(line.timestamp).toLocaleTimeString("en-US", {
                        hour12: false,
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                    <span
                      className={`break-all whitespace-pre-wrap ${lineColor(line.type)}`}
                      title={
                        display.summarised
                          ? `Original ${display.originalBytes} bytes — collapsed for display`
                          : undefined
                      }
                    >
                      {display.display}
                    </span>
                  </div>
                );
              })()
            ))}
            {connState === "done" && (
              <p className="pt-1 text-zinc-600">— end of output —</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
