"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { shapeAgentChunk } from "./utils/agent-chunk";

const MAX_OUTPUT_CHARS = 8000;

interface AgentCardProps {
  taskId: string;
  assignedTo: string;
  title: string;
  modelUsed?: string | null;
  createdBy?: string | null;
  status?: string | null;
  parentTaskId?: string | null;
  goalId?: string | null;
  goalTitle?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  adapterType?: string | null;
  onCancelled?: (taskId: string) => void;
}

// Strip a leading "provider/" prefix for display — e.g.
// "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6". The full string is
// preserved in the title attribute so operators can still read it on hover.
function formatModelLabel(modelUsed: string | null | undefined): string {
  if (!modelUsed) return "model pending";
  const slashIx = modelUsed.indexOf("/");
  return slashIx >= 0 ? modelUsed.slice(slashIx + 1) : modelUsed;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function AgentCard({
  taskId,
  assignedTo,
  title,
  modelUsed,
  createdBy,
  status,
  parentTaskId,
  goalId,
  goalTitle,
  createdAt,
  updatedAt,
  adapterType,
  onCancelled,
}: AgentCardProps) {
  const [output, setOutput] = useState("");
  const outputRef = useRef<HTMLPreElement | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  useEffect(() => {
    if (cancelled) return;
    const es = new EventSource(`/api/tasks/${taskId}/stream`);
    es.onmessage = (event) => {
      let parsed: { type?: string; chunk?: string };
      try {
        parsed = JSON.parse(event.data) as { type?: string; chunk?: string };
      } catch {
        return;
      }
      if (parsed.type === "connected" || parsed.type === "done" || parsed.type === "status") return;
      if (typeof parsed.chunk !== "string" || parsed.chunk.length === 0) return;
      // Live cards skip stderr entirely — it's diagnostic noise; the full
      // panel inside the task detail still shows it inline, colour-coded.
      if (parsed.type === "stderr") return;
      const shaped = shapeAgentChunk(parsed.chunk);
      setOutput((prev) => {
        const sep = shaped.summarised && prev && !prev.endsWith("\n") ? "\n" : "";
        const next = prev + sep + shaped.display;
        return next.length > MAX_OUTPUT_CHARS
          ? next.slice(next.length - MAX_OUTPUT_CHARS)
          : next;
      });
    };
    es.onerror = () => {
      // EventSource auto-reconnects on transient errors.
    };
    return () => {
      es.close();
    };
  }, [taskId, cancelled]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const handleCancel = async () => {
    if (!window.confirm(`Cancel task "${title}"?\n\nThis will stop the agent and mark the task as cancelled.`)) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        alert(`Failed to cancel: ${body.error ?? `HTTP ${res.status}`}`);
        return;
      }
      setCancelled(true);
      onCancelled?.(taskId);
    } finally {
      setCancelling(false);
    }
  };

  const modelLabel = formatModelLabel(modelUsed);
  const lastActivity = updatedAt ?? createdAt;

  if (cancelled) {
    return (
      <div
        data-testid="agent-card"
        className="flex h-64 flex-col rounded-[12px] border border-white/[0.06] bg-[#0F1114] p-4"
        aria-label={`Cancelled task: ${title}`}
      >
        <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Task cancelled</p>
        <p className="mt-1.5 line-clamp-2 text-[13px] text-[#B8B0A0]">{title}</p>
      </div>
    );
  }

  return (
    <div
      data-testid="agent-card"
      className="flex h-64 flex-col rounded-[12px] border border-white/[0.06] bg-card p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-colors hover:border-white/[0.12]"
    >
      {/* Header: role badge, adapter, model, cancel */}
      <div className="mb-2 flex items-start justify-between gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="shrink-0 rounded-[6px] border border-honey-700/40 bg-honey-700/15 px-2 py-0.5 text-[11px] font-semibold text-honey-300">
            {assignedTo}
          </span>
          {adapterType && (
            <span className="shrink-0 rounded-[6px] border border-white/[0.06] bg-[#0F1114] px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {adapterType}
            </span>
          )}
          <span
            className="min-w-0 max-w-[10rem] truncate rounded-[6px] border border-white/[0.06] bg-[#0F1114] px-2 py-0.5 font-mono text-[10px] text-[#B8B0A0]"
            title={modelUsed ?? "Model not reported yet"}
            data-testid="agent-card-model"
          >
            {modelLabel}
          </span>
        </div>
        <button
          onClick={handleCancel}
          disabled={cancelling}
          aria-label={`Cancel task: ${title}`}
          className="shrink-0 rounded-[6px] border border-[rgba(194,74,44,0.35)] px-2 py-0.5 text-[10px] text-[#F0A096] transition-colors hover:border-[rgba(194,74,44,0.6)] hover:bg-[rgba(194,74,44,0.12)] hover:text-[#FFD0C2] disabled:opacity-50"
        >
          {cancelling ? "…" : "Cancel"}
        </button>
      </div>

      {/* Title — links to task detail */}
      <Link
        href={`/tasks/${taskId}`}
        aria-label={`Open task: ${title}`}
        data-testid="agent-card-link"
        className="mb-1 line-clamp-1 text-[14px] font-semibold leading-[18px] text-foreground hover:text-honey-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {title}
      </Link>

      {/* Identity context: goal, status, creator, timing */}
      <div className="mb-2 space-y-1">
        {goalTitle && goalId && (
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <span className="shrink-0 text-[10px] uppercase tracking-[0.06em] text-[#6F6A60]">Goal</span>
            <Link
              href={`/goals/${goalId}`}
              className="min-w-0 truncate text-[11px] text-[#B8B0A0] hover:text-honey-300"
            >
              {goalTitle}
            </Link>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          {status && (
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`inline-block size-1.5 rounded-full ${
                  status === "active" ? "bg-[#7E9B7E]" : "bg-honey-500"
                }`}
              />
              {status}
            </span>
          )}
          {createdBy && <span title={`Created by ${createdBy}`}>by {createdBy}</span>}
          {parentTaskId && <span title="Spawned from a parent task">↳ spawn</span>}
          {lastActivity && (
            <span title={lastActivity} className="font-variant-numeric tabular-nums">
              {relativeTime(lastActivity)}
            </span>
          )}
        </div>
      </div>

      {/* Live output stream */}
      <pre
        ref={outputRef}
        data-testid="agent-card-output"
        className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-[8px] border border-white/[0.04] bg-[#0F1114] p-2 font-mono text-[11px] leading-snug text-[#D4C8A8]"
      >
        {output.length === 0 ? (
          <span className="text-muted-foreground">Waiting for output…</span>
        ) : (
          output
        )}
      </pre>
    </div>
  );
}
