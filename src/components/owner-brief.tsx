"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

type GoalHealth = "on_track" | "waiting_on_owner" | "stalled" | "at_risk" | "achieved";

interface BriefPayload {
  flags: {
    urgentDecisions: number;
    pendingDecisions?: number;
    pendingQualityFeedback?: number;
    totalPendingDecisions: number;
    stalledGoals: number;
    waitingGoals: number;
    atRiskGoals: number;
    unresolvableTasks: number;
    expiringCreds: number;
  };
  pendingDecisions: Array<{
    id: string;
    title: string;
    priority: "urgent" | "normal";
    context: string;
    createdAt: string;
    ageHours: number;
  }>;
  goals: Array<{
    id: string;
    title: string;
    status: string;
    health: GoalHealth;
    progress: { done: number; failed: number; open: number; total: number };
    idleHours: number;
    pendingDecisions: number;
    budgetCents: number | null;
    spentCents: number | null;
  }>;
  recentCompletions: Array<{
    id: string;
    title: string;
    role: string;
    completedAt: string;
  }>;
  newInsights: Array<{
    id: string;
    content: string;
    priority: "high" | "medium" | "low";
    connectionType: string;
  }>;
  costs: { todayCents: number; weekCents: number; monthCents: number };
  activity: { tasksCompleted24h: number; tasksFailed24h: number; goalsCompleted7d: number };
  initiative: {
    latestRun: null | {
      id: string;
      trigger: string;
      status: string;
      startedAt: string;
      completedAt: string | null;
      evaluatedCandidates: number;
      createdCount: number;
      created: { goals: number; tasks: number; decisions: number };
      suppressedCount: number;
      runFailures: number;
      failureReason: string | null;
      topSuppressionReasons: Array<{ reason: string; count: number }>;
    };
    last7d: {
      windowHours: number;
      runCount: number;
      completedRuns: number;
      failedRuns: number;
      evaluatedCandidates: number;
      createdItems: number;
      suppressedItems: number;
      runFailures: number;
      suppressionReasons: Array<{ reason: string; count: number }>;
    };
  };
  operationLock?: {
    creationPause?: {
      paused: boolean;
      reason: string | null;
      pausedBy: string | null;
      updatedAt: string | null;
    };
    resumeReadiness?: {
      status: "running" | "ready" | "blocked";
      canResumeSafely: boolean;
      counts: {
        enabledSchedules: number;
        runnableTasks: number;
        pendingDecisions: number;
        unresolvableTasks: number;
      };
      models: {
        enabled: number;
        ready: number;
        blocked: number;
        blockedRoutes: Array<{
          provider: string;
          adapterType: string;
          modelId: string;
          canRun: boolean;
          reason: string;
          status?: string | null;
          lastProbedAt?: string | null;
          nextProbeAt?: string | null;
          failureReason?: string | null;
          freshness?: "unknown" | "fresh" | "due";
        }>;
      };
      sessions?: {
        persistentRoutes: number;
        fallbackRoutes: number;
        routes: Array<{
          provider: string;
          adapterType: string;
          modelId: string;
          persistentSessions: boolean;
        }>;
      };
      blockers: Array<{
        code: string;
        label: string;
        count: number;
        detail: string;
      }>;
      checkedAt: string;
    };
  };
  generatedAt: string;
}

async function fetchBrief(hiveId: string): Promise<BriefPayload> {
  const res = await fetch(`/api/brief?hiveId=${hiveId}`);
  if (!res.ok) throw new Error(`brief failed: ${res.status}`);
  const body = await res.json();
  return body.data;
}

function cents(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const HEALTH_STYLES: Record<GoalHealth, { bg: string; text: string; ring: string; label: string }> = {
  on_track: {
    bg: "bg-[rgba(126,155,126,0.14)]",
    text: "text-[#C7D8C2]",
    ring: "ring-1 ring-inset ring-[rgba(126,155,126,0.32)]",
    label: "on track",
  },
  waiting_on_owner: {
    bg: "bg-[rgba(229,154,27,0.14)]",
    text: "text-honey-300",
    ring: "ring-1 ring-inset ring-[rgba(229,154,27,0.32)]",
    label: "waiting on you",
  },
  stalled: {
    bg: "bg-white/[0.04]",
    text: "text-[#B8B0A0]",
    ring: "ring-1 ring-inset ring-white/[0.06]",
    label: "stalled",
  },
  at_risk: {
    bg: "bg-[rgba(194,74,44,0.16)]",
    text: "text-[#F0A096]",
    ring: "ring-1 ring-inset ring-[rgba(194,74,44,0.4)]",
    label: "at risk",
  },
  achieved: {
    bg: "bg-[rgba(126,155,126,0.18)]",
    text: "text-[#C7D8C2]",
    ring: "ring-1 ring-inset ring-[rgba(126,155,126,0.36)]",
    label: "achieved",
  },
};

export function OwnerBrief({ hiveId }: { hiveId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["brief", hiveId],
    queryFn: () => fetchBrief(hiveId),
    refetchInterval: 30_000,
  });

  if (isLoading) return <p className="text-[13px] text-muted-foreground">Assembling brief…</p>;
  if (error || !data)
    return <p className="text-[13px] text-[#F0A096]">Brief unavailable.</p>;

  const urgent = data.flags.urgentDecisions > 0 || data.flags.unresolvableTasks > 0;
  const creationPaused = data.operationLock?.creationPause?.paused ?? false;
  const resumeReadiness = data.operationLock?.resumeReadiness;

  return (
    <div className="space-y-6">
      {/* Top-line: counters + red-flag row */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <StatCard
          label="Waiting on you"
          value={String(data.flags.pendingDecisions ?? data.flags.totalPendingDecisions)}
          accent={data.flags.urgentDecisions > 0 ? "urgent" : "normal"}
          href="/decisions"
        />
        {(data.flags.pendingQualityFeedback ?? 0) > 0 && (
          <StatCard
            label="Quality feedback"
            value={String(data.flags.pendingQualityFeedback)}
            href="/quality-feedback"
          />
        )}
        <StatCard
          label="Active goals"
          value={String(
            data.goals.filter((g) => g.status === "active").length,
          )}
          sub={
            data.flags.stalledGoals + data.flags.atRiskGoals > 0
              ? `${data.flags.stalledGoals + data.flags.atRiskGoals} need attention`
              : "all healthy"
          }
          href="/goals"
        />
        <StatCard
          label="Done today"
          value={String(data.activity.tasksCompleted24h)}
          sub={
            data.activity.tasksFailed24h > 0
              ? `${data.activity.tasksFailed24h} failed`
              : undefined
          }
          href="/tasks"
        />
        <StatCard
          label="Initiative created"
          value={String(data.initiative.last7d.createdItems)}
          sub={
            data.initiative.last7d.suppressedItems > 0
              ? `${data.initiative.last7d.suppressedItems} suppressed in 7d`
              : `${data.initiative.last7d.runCount} runs in 7d`
          }
        />
        <StatCard
          label="Spend this month"
          value={cents(data.costs.monthCents)}
          sub={`today ${cents(data.costs.todayCents)}`}
          href="/analytics"
        />
      </section>

      {urgent && (
        <section className="rounded-[12px] border border-[rgba(194,74,44,0.4)] bg-[rgba(194,74,44,0.08)] p-4 shadow-[0_0_24px_-4px_rgba(194,74,44,0.35)]">
          <p className="text-[13px] leading-[18px] font-medium text-[#F2EBDD]">
            {data.flags.urgentDecisions > 0 &&
              `${data.flags.urgentDecisions} urgent decision${data.flags.urgentDecisions === 1 ? "" : "s"} waiting. `}
            {data.flags.unresolvableTasks > 0 &&
              `${data.flags.unresolvableTasks} unresolvable task${data.flags.unresolvableTasks === 1 ? "" : "s"}. `}
            {data.flags.expiringCreds > 0 &&
              `${data.flags.expiringCreds} credential${data.flags.expiringCreds === 1 ? "" : "s"} expiring within 7 days.`}
          </p>
        </section>
      )}

      {creationPaused && resumeReadiness && (
        <section className="rounded-[12px] border border-white/[0.06] bg-card p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">
                Resume readiness
              </p>
              <h2 className="mt-1 text-[20px] leading-[26px] font-semibold text-foreground">
                Hive paused
              </h2>
              <p className="mt-1 text-[13px] leading-[18px] text-muted-foreground tabular-nums">
                {`${resumeReadiness.models.ready}/${resumeReadiness.models.enabled} models ready · ${resumeReadiness.counts.runnableTasks} runnable · ${resumeReadiness.counts.pendingDecisions} decisions`}
              </p>
              {resumeReadiness.sessions && (
                <p className="mt-1 text-[12px] text-[#6F6A60] tabular-nums">
                  {`${resumeReadiness.sessions.persistentRoutes} persistent-session route${resumeReadiness.sessions.persistentRoutes === 1 ? "" : "s"} · ${resumeReadiness.sessions.fallbackRoutes} fresh-session fallback${resumeReadiness.sessions.fallbackRoutes === 1 ? "" : "s"}`}
                </p>
              )}
            </div>
            <span
              className={`shrink-0 rounded-[6px] px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${
                resumeReadiness.canResumeSafely
                  ? "bg-[rgba(126,155,126,0.16)] text-[#C7D8C2] ring-[rgba(126,155,126,0.36)]"
                  : "bg-[rgba(194,74,44,0.16)] text-[#F0A096] ring-[rgba(194,74,44,0.4)]"
              }`}
            >
              {resumeReadiness.canResumeSafely ? "Ready" : "Blocked"}
            </span>
          </div>

          {resumeReadiness.blockers.length === 0 ? (
            <p className="mt-4 text-[13px] text-foreground/85">
              No resume blockers detected.
            </p>
          ) : (
            <ul className="mt-4 grid gap-2 md:grid-cols-2">
              {resumeReadiness.blockers.map((blocker) => (
                <li
                  key={blocker.code}
                  className="rounded-[10px] border border-white/[0.06] bg-[#0F1114] p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[13px] font-semibold text-foreground">
                      {blocker.label}
                    </p>
                    <span className="shrink-0 rounded-[6px] border border-honey-700/40 bg-honey-700/15 px-1.5 py-0.5 text-[11px] font-semibold text-honey-300 tabular-nums">
                      {blocker.count}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[12px] leading-[16px] text-muted-foreground">
                    {blocker.detail}
                  </p>
                </li>
              ))}
            </ul>
          )}

          {resumeReadiness.models.blockedRoutes.length > 0 && (
            <div className="mt-4 border-t border-white/[0.06] pt-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#6F6A60]">
                Model routes blocked
              </p>
              <ul className="mt-2 space-y-1 text-[12px] text-foreground/85">
                {resumeReadiness.models.blockedRoutes.slice(0, 4).map((model) => (
                  <li key={`${model.adapterType}:${model.modelId}`} className="flex flex-wrap gap-x-2 gap-y-1">
                    <span className="font-mono font-medium text-honey-300">{model.modelId}</span>
                    <span className="text-[#B8B0A0]">{model.adapterType}</span>
                    <span className="text-muted-foreground">
                      {model.freshness ?? "unknown"} · {model.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section className="rounded-[12px] border border-white/[0.06] bg-card p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">
              Initiative engine
            </p>
            <h2 className="mt-1 text-[20px] leading-[26px] font-semibold text-foreground">
              Last 7 days
            </h2>
            <p className="mt-1 text-[13px] leading-[18px] text-muted-foreground tabular-nums">
              {data.initiative.last7d.runCount} run{data.initiative.last7d.runCount === 1 ? "" : "s"}, {data.initiative.last7d.createdItems} created, {data.initiative.last7d.suppressedItems} suppressed
            </p>
          </div>
          {data.initiative.latestRun && (
            <span
              className={`shrink-0 rounded-[6px] px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${
                data.initiative.latestRun.status === "failed"
                  ? "bg-[rgba(194,74,44,0.16)] text-[#F0A096] ring-[rgba(194,74,44,0.4)]"
                  : "bg-[rgba(126,155,126,0.16)] text-[#C7D8C2] ring-[rgba(126,155,126,0.36)]"
              }`}
            >
              latest {data.initiative.latestRun.status}
            </span>
          )}
        </div>

        {data.initiative.latestRun ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-[10px] border border-white/[0.06] bg-[#0F1114] p-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#6F6A60]">
                Latest run
              </p>
              <p className="mt-1 text-[14px] font-semibold text-foreground tabular-nums">{relTime(data.initiative.latestRun.startedAt)}</p>
              <p className="mt-1 text-[12px] leading-[16px] text-muted-foreground">
                {data.initiative.latestRun.trigger} evaluated {data.initiative.latestRun.evaluatedCandidates} candidates, created {data.initiative.latestRun.createdCount}, suppressed {data.initiative.latestRun.suppressedCount}.
              </p>
              {data.initiative.latestRun.failureReason && (
                <p className="mt-2 text-[12px] text-[#F0A096]">
                  Failure: {data.initiative.latestRun.failureReason}
                </p>
              )}
            </div>
            <div className="rounded-[10px] border border-white/[0.06] bg-[#0F1114] p-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#6F6A60]">
                Top suppression reasons
              </p>
              {data.initiative.latestRun.topSuppressionReasons.length === 0 ? (
                <p className="mt-1 text-[12px] text-muted-foreground">
                  No suppressions recorded in the latest run.
                </p>
              ) : (
                <ul className="mt-2 space-y-1 text-[12px] text-foreground/85">
                  {data.initiative.latestRun.topSuppressionReasons.map((reason) => (
                    <li key={reason.reason} className="flex justify-between gap-2 tabular-nums">
                      <span>{reason.reason}</span>
                      <span className="text-honey-300">{reason.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <p className="mt-3 text-[13px] text-muted-foreground">
            No initiative runs recorded yet.
          </p>
        )}
      </section>

      {/* Pending decisions */}
      {data.pendingDecisions.length > 0 && (
        <section>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">
            Needs your input
          </p>
          <h2 className="mb-3 text-[15px] leading-[22px] font-semibold text-foreground">
            Pending decisions
          </h2>
          <div className="space-y-2">
            {data.pendingDecisions.map((d) => (
              <Link
                key={d.id}
                href={`/decisions`}
                className="block rounded-[12px] border border-white/[0.06] bg-card p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-colors hover:border-white/[0.12]"
              >
                <div className="mb-1.5 flex items-center gap-2">
                  {d.priority === "urgent" && (
                    <span className="rounded-[6px] bg-[rgba(194,74,44,0.16)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#F0A096] ring-1 ring-inset ring-[rgba(194,74,44,0.4)]">
                      Urgent
                    </span>
                  )}
                  <p className="text-[14px] font-semibold text-foreground">{d.title}</p>
                  <span className="ml-auto text-[12px] text-muted-foreground tabular-nums">
                    {d.ageHours > 24
                      ? `${Math.round(d.ageHours / 24)}d`
                      : `${Math.round(d.ageHours)}h`}{" "}
                    old
                  </span>
                </div>
                <p className="line-clamp-2 text-[12px] leading-[16px] text-muted-foreground">{d.context}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Active goals with health */}
      {data.goals.length > 0 && (
        <section>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">
            Goals
          </p>
          <h2 className="mb-3 text-[15px] leading-[22px] font-semibold text-foreground">
            Active goal health
          </h2>
          <div className="space-y-2">
            {data.goals.map((g) => {
              const hs = HEALTH_STYLES[g.health];
              const pct =
                g.progress.total > 0
                  ? Math.round((g.progress.done / g.progress.total) * 100)
                  : 0;
              return (
                <Link
                  key={g.id}
                  href={`/goals/${g.id}`}
                  className="block rounded-[12px] border border-white/[0.06] bg-card p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-colors hover:border-white/[0.12]"
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <p className="line-clamp-2 text-[14px] font-semibold leading-[20px] text-foreground">
                      {g.title}
                    </p>
                    <span
                      className={`shrink-0 rounded-[6px] px-2 py-0.5 text-[11px] font-semibold ${hs.bg} ${hs.text} ${hs.ring}`}
                    >
                      {hs.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-[12px] text-muted-foreground tabular-nums">
                    <div className="flex-1">
                      <div className="h-1 overflow-hidden rounded-full bg-white/[0.05]">
                        <div
                          className="h-full bg-[var(--honey-500)]"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    <span className="shrink-0 text-[#B8B0A0]">
                      {g.progress.done}/{g.progress.total}
                    </span>
                    {g.idleHours > 24 && (
                      <span className="shrink-0 text-[#6F6A60]">
                        idle {Math.round(g.idleHours)}h
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Insights + recent wins side by side */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">
            New insights
          </p>
          <h2 className="mb-3 text-[15px] leading-[22px] font-semibold text-foreground tabular-nums">
            {data.newInsights.length} since last look
          </h2>
          {data.newInsights.length === 0 ? (
            <p className="rounded-[12px] border border-dashed border-white/[0.06] bg-[#0F1114] p-4 text-[12px] text-muted-foreground">
              No new synthesis insights since your last look.
            </p>
          ) : (
            <ul className="space-y-2">
              {data.newInsights.map((i) => (
                <li
                  key={i.id}
                  className="rounded-[12px] border border-white/[0.06] bg-card p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
                >
                  <div className="mb-2 flex items-center gap-2">
                    <span className="rounded-[6px] border border-honey-700/40 bg-honey-700/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-honey-300">
                      {i.connectionType}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{i.priority} priority</span>
                  </div>
                  <p className="line-clamp-3 text-[13px] leading-[18px] text-foreground/90">{i.content}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-honey-300/80">
            Recently completed
          </p>
          <h2 className="mb-3 text-[15px] leading-[22px] font-semibold text-foreground">
            Last 24 hours
          </h2>
          {data.recentCompletions.length === 0 ? (
            <p className="rounded-[12px] border border-dashed border-white/[0.06] bg-[#0F1114] p-4 text-[12px] text-muted-foreground">
              Nothing completed in the last 24 hours.
            </p>
          ) : (
            <ul className="space-y-0.5 rounded-[12px] border border-white/[0.06] bg-card p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              {data.recentCompletions.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/tasks/${t.id}`}
                    aria-label={`View completed task: ${t.title}`}
                    className="flex items-center justify-between gap-2 rounded-[8px] px-3 py-1.5 text-[12px] text-foreground/85 transition-colors hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <span className="truncate">
                      <span className="mr-2 font-mono text-[10px] text-honey-300/80">{t.role}</span>
                      {t.title}
                    </span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {relTime(t.completedAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <p className="text-right text-[11px] text-[#6F6A60] tabular-nums">
        Brief generated {relTime(data.generatedAt)}
      </p>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
  href,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "urgent" | "normal";
  href?: string;
}) {
  const body = (
    <div
      className={`h-full rounded-[12px] border p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] ${
        accent === "urgent"
          ? "border-[rgba(194,74,44,0.4)] bg-[rgba(194,74,44,0.08)]"
          : "border-white/[0.06] bg-card"
      }`}
    >
      <p
        className={`text-[10px] font-semibold uppercase tracking-[0.08em] ${
          accent === "urgent" ? "text-[#F0A096]/80" : "text-honey-300/70"
        }`}
      >
        {label}
      </p>
      <p
        className={`mt-1 text-[28px] leading-[34px] font-semibold tracking-[-0.01em] tabular-nums ${
          accent === "urgent" ? "text-[#F8C9BD]" : "text-foreground"
        }`}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-[12px] text-muted-foreground tabular-nums">{sub}</p>}
    </div>
  );
  return href ? (
    <Link
      href={href}
      className="block h-full transition-colors [&>div]:transition-colors [&>div:hover]:border-white/[0.12]"
    >
      {body}
    </Link>
  ) : (
    body
  );
}
