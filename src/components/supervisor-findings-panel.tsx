"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, RefreshCw } from "lucide-react";
import type {
  HiveHealthReport,
  SupervisorActions,
  AppliedOutcome,
  FindingKind,
  FindingSeverity,
} from "@/supervisor/types";

/**
 * SupervisorFindingsPanel — dashboard-home read-only view of the hive
 * supervisor heartbeat history. Pulls from /api/supervisor-reports
 * (already hive-scoped + limit-capped) and renders one row per run with
 * timestamp, finding count by severity, applied-action count, and cost.
 *
 * Deliberately read-only: this is observability, not control. The
 * dashboard has the per-goal supervisor activity panel for live tailing;
 * this panel is the historical audit trail.
 */

interface ReportRow {
  id: string;
  hiveId: string;
  ranAt: string;
  report: HiveHealthReport;
  actions: SupervisorActions | null;
  actionOutcomes: AppliedOutcome[] | null;
  agentTaskId: string | null;
  freshInputTokens: number | null;
  cachedInputTokens: number | null;
  cachedInputTokensKnown: boolean;
  totalContextTokens: number | null;
  estimatedBillableCostCents: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  costCents: number | null;
}

const POLL_MS = 30_000;
const DEFAULT_LIMIT = 5;

async function fetchReports(
  hiveId: string,
  limit: number,
): Promise<ReportRow[]> {
  const res = await fetch(
    `/api/supervisor-reports?hiveId=${hiveId}&limit=${limit}`,
  );
  if (!res.ok) throw new Error(`supervisor-reports failed: ${res.status}`);
  const body = (await res.json()) as { data: ReportRow[] };
  return body.data ?? [];
}

interface DigestRunResult {
  reportId: string;
  findings: number;
  summary: string;
}

async function runDigest(hiveId: string): Promise<DigestRunResult> {
  const res = await fetch(`/api/supervisor-reports?hiveId=${hiveId}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`supervisor digest failed: ${res.status}`);
  const body = (await res.json()) as { data: DigestRunResult };
  return body.data;
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function countBySeverity(report: HiveHealthReport): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = { info: 0, warn: 0, critical: 0 };
  for (const f of report.findings ?? []) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  return counts;
}

function summarizeFindings(report: HiveHealthReport): string {
  const kinds = new Map<FindingKind, number>();
  for (const f of report.findings ?? []) {
    kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
  }
  if (kinds.size === 0) return "no findings";
  return Array.from(kinds.entries())
    .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`)
    .join(" · ");
}

function appliedCount(outcomes: AppliedOutcome[] | null): number {
  if (!outcomes) return 0;
  return outcomes.filter((o) => o.status === "applied").length;
}

function centsLabel(cents: number | null): string | null {
  if (cents === null || cents === 0) return null;
  return `$${(cents / 100).toFixed(2)}`;
}

function contextLabel(tokens: number | null): string | null {
  if (tokens === null || tokens === 0) return null;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k ctx`;
  return `${tokens} ctx`;
}

function findingRefLabel(ref: HiveHealthReport["findings"][number]["ref"]): string | null {
  const parts = [
    ref.taskId ? `task ${ref.taskId}` : null,
    ref.goalId ? `goal ${ref.goalId}` : null,
    ref.decisionId ? `decision ${ref.decisionId}` : null,
    ref.role ? `role ${ref.role}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function findingDetailLabel(detail: Record<string, unknown>): string | null {
  const entries = Object.entries(detail);
  if (entries.length === 0) return null;
  return entries
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ");
}

export function SupervisorFindingsPanel({
  hiveId,
  limit = DEFAULT_LIMIT,
}: {
  hiveId: string;
  limit?: number;
}) {
  const queryClient = useQueryClient();
  const [runError, setRunError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<DigestRunResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["supervisor-reports", hiveId, limit],
    queryFn: () => fetchReports(hiveId, limit),
    refetchInterval: POLL_MS,
  });

  async function handleRunDigest() {
    setIsRunning(true);
    setRunError(null);
    try {
      const result = await runDigest(hiveId);
      setLastRun(result);
      await queryClient.invalidateQueries({
        queryKey: ["supervisor-reports", hiveId, limit],
      });
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Supervisor digest failed");
    } finally {
      setIsRunning(false);
    }
  }

  const controls = (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div>
        {lastRun && (
          <p className="text-[12px] text-muted-foreground">
            {lastRun.summary}
          </p>
        )}
        {runError && (
          <p className="text-[12px] text-[#F0A096]">
            {runError}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={handleRunDigest}
        disabled={isRunning}
        className="inline-flex items-center gap-1.5 rounded-[8px] border border-white/[0.06] bg-[#0F1114] px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:border-honey-500/45 hover:text-honey-300 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${isRunning ? "animate-spin" : ""}`} aria-hidden="true" />
        {isRunning ? "Running…" : "Run digest"}
      </button>
    </div>
  );

  if (isLoading) {
    return (
      <>
        {controls}
        <p className="text-[13px] text-muted-foreground" role="status">
          Loading supervisor findings…
        </p>
      </>
    );
  }

  if (error) {
    return (
      <>
        {controls}
        <p className="text-[13px] text-[#F0A096]">
          Supervisor findings unavailable.
        </p>
      </>
    );
  }

  if (!data || data.length === 0) {
    return (
      <>
        {controls}
        <p className="rounded-[12px] border border-dashed border-white/[0.06] bg-[#0F1114] p-4 text-[12px] text-muted-foreground">
          No supervisor runs yet — run a digest now or wait for the heartbeat to log a row when it finds something worth surfacing.
        </p>
      </>
    );
  }

  return (
    <>
      {controls}
      <ul className="space-y-2">
        {data.map((r) => {
          const sev = countBySeverity(r.report);
          const findings = r.report.findings ?? [];
          const total = findings.length;
          const applied = appliedCount(r.actionOutcomes);
          const emitted = r.actions?.actions?.length ?? 0;
          const billableCost = centsLabel(r.estimatedBillableCostCents ?? r.costCents);
          const ctx = contextLabel(r.totalContextTokens ?? r.tokensInput);
          const expanded = expandedReportId === r.id;
          return (
            <li
              key={r.id}
              className="rounded-[12px] border border-white/[0.06] bg-card p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
            >
              <button
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? "Hide finding details" : "Show finding details"}
                onClick={() => setExpandedReportId(expanded ? null : r.id)}
                className="w-full cursor-pointer rounded-[8px] text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <span className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[14px] font-semibold text-foreground tabular-nums">
                    {total} finding{total === 1 ? "" : "s"}
                    {sev.critical > 0 && (
                      <span className="ml-2 rounded-[6px] bg-[rgba(194,74,44,0.16)] px-2 py-0.5 text-[11px] font-semibold text-[#F0A096] ring-1 ring-inset ring-[rgba(194,74,44,0.4)]">
                        {sev.critical} critical
                      </span>
                    )}
                    {sev.warn > 0 && (
                      <span className="ml-2 rounded-[6px] bg-honey-700/15 px-2 py-0.5 text-[11px] font-semibold text-honey-300 ring-1 ring-inset ring-honey-700/40">
                        {sev.warn} warn
                      </span>
                    )}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground tabular-nums">
                    {relTime(r.ranAt)}
                    <ChevronDown
                      className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
                      aria-hidden="true"
                    />
                  </span>
                </span>
                <span className="line-clamp-2 text-[12px] leading-[16px] text-foreground/85">
                  {r.actions?.summary ?? summarizeFindings(r.report)}
                </span>
              </button>
              <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground tabular-nums">
                <span>
                  actions {applied}/{emitted} applied
                </span>
                {ctx && <span title="Total context processed (input + cached)">{ctx}</span>}
                {billableCost && (
                  <span title="Estimated billable cost (excludes cached token discount)">
                    est. {billableCost}
                  </span>
                )}
              </div>
              {expanded && (
                <div className="mt-3 border-t border-white/[0.06] pt-3">
                  {findings.length === 0 ? (
                    <p className="text-[12px] text-muted-foreground">
                      No findings in this report.
                    </p>
                  ) : (
                    <ul className="space-y-2.5">
                      {findings.map((finding) => {
                        const ref = findingRefLabel(finding.ref);
                        const detail = findingDetailLabel(finding.detail);
                        return (
                          <li key={finding.id} className="text-[12px] text-foreground">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded-[6px] border border-honey-700/40 bg-honey-700/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-honey-300">
                                {finding.kind.replace(/_/g, " ")}
                              </span>
                              <span className="text-[11px] text-muted-foreground">
                                {finding.severity}
                              </span>
                            </div>
                            <p className="mt-1.5 leading-[16px] text-foreground/90">
                              {finding.summary || finding.id}
                            </p>
                            {ref && (
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                {ref}
                              </p>
                            )}
                            {detail && (
                              <p className="mt-1 break-words font-mono text-[10px] text-[#B8B0A0]">
                                {detail}
                              </p>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
