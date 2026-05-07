"use client";

import { useEffect, useRef, useState } from "react";

/**
 * SupervisorActivityPanel — renders the goal supervisor's parsed thoughts and
 * tool calls. Polls /api/goals/:id/supervisor every 5 s while the goal is
 * active so wake-ups appear without a page refresh.
 *
 * Read-only: just paints what's already on disk in the codex rollout file.
 * Does NOT touch the dispatcher, supervisor process, or DB writes.
 */

interface SupervisorEvent {
  ts: string;
  type:
    | "session_meta"
    | "assistant_message"
    | "reasoning"
    | "tool_call"
    | "tool_output"
    | "user_message"
    | "other";
  label: string;
  body: string;
}

interface SupervisorActivity {
  threadId: string | null;
  workspacePath: string | null;
  rolloutPath: string | null;
  lastActivityAt: string | null;
  active: boolean;
  events: SupervisorEvent[];
  goalStatus: string;
}

const POLL_MS = 5_000;
const AUTO_SCROLL_THRESHOLD_PX = 80;

function formatTime(ts: string) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return ts;
  }
}

function formatRelative(ts: string | null): string {
  if (!ts) return "never";
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function eventStyle(type: SupervisorEvent["type"]): { color: string; prefix: string } {
  switch (type) {
    case "assistant_message":
      return { color: "text-amber-200", prefix: "💭" };
    case "reasoning":
      return { color: "text-zinc-400 italic", prefix: "·" };
    case "tool_call":
      return { color: "text-blue-300", prefix: "$" };
    case "tool_output":
      return { color: "text-zinc-400", prefix: "→" };
    case "user_message":
      return { color: "text-emerald-300", prefix: "📥" };
    case "session_meta":
      return { color: "text-zinc-500", prefix: "—" };
    default:
      return { color: "text-zinc-300", prefix: "•" };
  }
}

export function SupervisorActivityPanel({ goalId }: { goalId: string }) {
  const [data, setData] = useState<SupervisorActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchActivity() {
      try {
        const res = await fetch(`/api/goals/${goalId}/supervisor`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data: SupervisorActivity };
        if (!cancelled) {
          setData(body.data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchActivity();

    // Only poll while goal is still active. Once it completes/fails, the
    // supervisor won't run again so we can stop hammering the API.
    const interval = setInterval(() => {
      if (data?.goalStatus && !["active", "pending"].includes(data.goalStatus)) return;
      fetchActivity();
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [goalId, data?.goalStatus]);

  // Auto-scroll inside the panel only while the reader is already following the tail.
  useEffect(() => {
    if (!data?.active) return;
    const output = outputRef.current;
    if (!output) return;
    const distanceFromBottom =
      output.scrollHeight - output.scrollTop - output.clientHeight;
    if (distanceFromBottom > AUTO_SCROLL_THRESHOLD_PX) return;
    output.scrollTop = output.scrollHeight;
  }, [data?.events.length, data?.active]);

  if (loading && !data) {
    return (
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Supervisor Activity</h2>
        <p className="text-sm text-zinc-500">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Supervisor Activity</h2>
        <p className="text-sm text-red-500">Failed to load: {error}</p>
      </div>
    );
  }

  if (!data || !data.threadId) {
    return (
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Supervisor Activity</h2>
        <p className="text-sm text-zinc-500">
          No supervisor session yet — the dispatcher will spawn one shortly after the goal is created.
        </p>
      </div>
    );
  }

  if (!data.rolloutPath) {
    return (
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Supervisor Activity</h2>
        <p className="text-sm text-zinc-500">
          Supervisor thread <span className="font-mono text-xs">{data.threadId.slice(0, 13)}</span> exists but no rollout file found yet.
        </p>
      </div>
    );
  }

  const visible = showAll ? data.events : data.events.slice(-50);
  const indicator = data.active
    ? { label: "● running", color: "text-green-400" }
    : { label: "○ idle", color: "text-zinc-400" };

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-3">
          <h2 className="text-lg font-semibold">Supervisor Activity</h2>
          <span className="text-xs text-zinc-500">
            thread <span className="font-mono">{data.threadId.slice(0, 13)}</span> ·
            {data.events.length} events ·
            last activity {formatRelative(data.lastActivityAt)}
          </span>
        </div>
        <span className={`font-mono text-xs ${indicator.color}`}>{indicator.label}</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-zinc-700">
        <div className="max-h-96 overflow-y-auto bg-zinc-950 p-3 font-mono text-xs" ref={outputRef}>
          {visible.length === 0 ? (
            <p className="text-zinc-500">No events captured yet.</p>
          ) : (
            <div className="space-y-1.5">
              {visible.map((ev, i) => {
                const style = eventStyle(ev.type);
                return (
                  <div key={i} className="flex gap-2 leading-5">
                    <span className="w-16 shrink-0 select-none text-zinc-600">
                      {formatTime(ev.ts)}
                    </span>
                    <span className="w-4 shrink-0 select-none">{style.prefix}</span>
                    <div className="min-w-0 flex-1">
                      <div className={`text-[10px] uppercase tracking-wide text-zinc-500`}>
                        {ev.label}
                      </div>
                      <pre className={`whitespace-pre-wrap break-words ${style.color}`}>
                        {ev.body}
                      </pre>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {!showAll && data.events.length > 50 && (
        <button
          onClick={() => setShowAll(true)}
          className="text-xs text-blue-500 hover:underline"
        >
          Show all {data.events.length} events
        </button>
      )}
    </div>
  );
}
