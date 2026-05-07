"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface SupervisorState {
  goalId: string;
  goalShortId?: string;
  title: string;
  threadId: string | null;
  lastActivityAt: string | null;
  state: "running" | "waking" | "idle" | "unknown";
}

const POLL_MS = 10_000;

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
  return `${Math.floor(h / 24)}d ago`;
}

function stateBadge(state: SupervisorState["state"]): { label: string; tone: string; dot: string } {
  switch (state) {
    case "running":
      return { label: "Running", tone: "text-[#C7D8C2]", dot: "bg-[#7E9B7E]" };
    case "waking":
      return { label: "Waking", tone: "text-[var(--honey-300)]", dot: "bg-[var(--honey-500)]" };
    case "idle":
      return { label: "Idle", tone: "text-[#B8B0A0]", dot: "bg-[rgba(184,137,90,0.55)]" };
    default:
      return { label: "Unknown", tone: "text-[#6F6A60]", dot: "bg-[rgba(184,137,90,0.32)]" };
  }
}

export function ActiveSupervisorsPanel({ hiveId }: { hiveId: string }) {
  const [data, setData] = useState<SupervisorState[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/active-supervisors?hiveId=${hiveId}`);
        if (!res.ok) return;
        const body = (await res.json()) as { data: SupervisorState[] };
        if (!cancelled) setData(body.data);
      } catch {
        // Swallow transient fetch errors (offline, server restart, etc).
        // Polling will retry; no need to surface them on the dashboard.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [hiveId]);

  if (loading) {
    return <p className="text-[13px] text-muted-foreground">Loading supervisors…</p>;
  }
  if (data.length === 0) {
    return (
      <p className="rounded-[12px] border border-dashed border-honey-700/40 bg-[#0F1114] px-4 py-4 text-[13px] text-muted-foreground">
        No active goal supervisors. Create a goal to spawn one.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {data.map((s) => {
        const badge = stateBadge(s.state);
        return (
          <Link
            key={s.goalId}
            href={`/goals/${s.goalId}`}
            className="block rounded-[12px] border border-white/[0.06] bg-card p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-colors hover:border-white/[0.12]"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="truncate text-[14px] font-semibold leading-[20px] text-foreground">
                {s.title}
              </p>
              <span className={`flex shrink-0 items-center gap-1.5 text-[11px] font-medium ${badge.tone}`}>
                <span aria-hidden="true" className={`inline-block size-1.5 rounded-full ${badge.dot}`} />
                {badge.label}
              </span>
            </div>
            <p className="mt-2 text-[12px] leading-[16px] text-muted-foreground">
              goal <span className="font-mono text-[#B8B0A0]">{s.goalShortId ?? s.goalId.slice(0, 8)}</span>
              {s.threadId ? (
                <>
                  <span className="mx-1.5 text-[#6F6A60]">·</span>
                  thread <span className="font-mono text-[#B8B0A0]">{s.threadId}</span>
                </>
              ) : null}
              <span className="mx-1.5 text-[#6F6A60]">·</span>
              last activity {formatRelative(s.lastActivityAt)}
            </p>
          </Link>
        );
      })}
    </div>
  );
}
