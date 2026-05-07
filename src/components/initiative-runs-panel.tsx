"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface InitiativeSuppressionReasonCount {
  reason: string;
  count: number;
}

interface InitiativeRunSummary {
  id: string;
  trigger: string;
  triggerRef: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  evaluatedCandidates: number;
  createdCount: number;
  suppressedCount: number;
  noopCount: number;
  runFailures: number;
  failureReason: string | null;
  topSuppressionReasons: InitiativeSuppressionReasonCount[];
}

interface InitiativeDecision {
  id: string;
  candidate_key: string;
  candidate_ref: string | null;
  candidate_kind: string;
  target_goal_id: string | null;
  target_goal_title: string | null;
  action_taken: "create_goal" | "create_task" | "suppress" | "noop" | string;
  created_goal_id: string | null;
  created_goal_title: string | null;
  created_task_id: string | null;
  created_task_title: string | null;
  suppression_reason: string | null;
  suppression_reasons: string[];
  rationale: string;
  classified_outcome?: {
    workItemType: string | null;
    classifiedRole: string | null;
    classification: {
      provider?: string;
      model?: string;
      confidence?: number;
      reasoning?: string;
      usedFallback?: boolean;
      role?: string;
    } | null;
  } | null;
}

interface InitiativeRunDetail extends InitiativeRunSummary {
  runId: string;
  decisions: InitiativeDecision[];
}

interface InitiativeRunsResponse {
  data?: {
    runs?: InitiativeRunSummary[];
  };
}

interface InitiativeRunDetailResponse {
  data?: {
    run?: InitiativeRunDetail;
  };
}

function formatDateTime(value: string | null): string {
  if (!value) return "Not completed";
  return new Date(value).toLocaleString();
}

function formatTriggerSource(trigger: string, triggerRef: string | null): string {
  if (trigger === "schedule" && triggerRef) return `schedule ${triggerRef}`;
  if (trigger === "manual") return "manual";
  return triggerRef ? `${trigger} ${triggerRef}` : trigger;
}

function formatReason(reason: string): string {
  return reason.replaceAll("_", " ");
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function toTitleCase(value: string): string {
  if (!value) return value;
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function actionBadgeClass(action: string): string {
  if (action === "create_task" || action === "create_goal") {
    return "bg-emerald-500/12 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200";
  }
  if (action === "suppress") {
    return "bg-amber-500/15 text-amber-900 dark:bg-amber-500/12 dark:text-amber-200";
  }
  return "bg-zinc-500/10 text-zinc-700 dark:bg-zinc-500/10 dark:text-zinc-200";
}

export function InitiativeRunsPanel({ hiveId }: { hiveId: string }) {
  const [runs, setRuns] = useState<InitiativeRunSummary[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runDetails, setRunDetails] = useState<Record<string, InitiativeRunDetail>>({});
  const [loading, setLoading] = useState(true);
  const [detailsLoadingId, setDetailsLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadRuns() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/initiative-runs?hiveId=${hiveId}`);
        if (!response.ok) {
          throw new Error(`Failed to load initiative runs (${response.status})`);
        }
        const payload = (await response.json()) as InitiativeRunsResponse;
        if (cancelled) return;
        const nextRuns = [...(payload.data?.runs ?? [])].sort(
          (left, right) =>
            new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime(),
        );
        setRuns(nextRuns);
      } catch (loadError) {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load initiative runs");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadRuns();
    return () => {
      cancelled = true;
    };
  }, [hiveId]);

  async function toggleRun(runId: string) {
    if (expandedRunId === runId) {
      setExpandedRunId(null);
      return;
    }

    setExpandedRunId(runId);
    if (runDetails[runId]) return;

    setDetailsLoadingId(runId);
    setError(null);
    try {
      const response = await fetch(`/api/initiative-runs/${runId}?hiveId=${hiveId}`);
      if (!response.ok) {
        throw new Error(`Failed to load run details (${response.status})`);
      }
      const payload = (await response.json()) as InitiativeRunDetailResponse;
      const runDetail = payload.data?.run;
      if (runDetail) {
        setRunDetails((current) => ({ ...current, [runId]: runDetail }));
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load run details");
    } finally {
      setDetailsLoadingId(null);
    }
  }

  if (loading) {
    return <p className="text-sm text-amber-700/75 dark:text-amber-300/70">Loading initiative runs...</p>;
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50/80 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
        {error}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-amber-300/70 bg-amber-50/60 p-6 text-sm text-amber-900 dark:border-amber-400/20 dark:bg-amber-500/5 dark:text-amber-100">
        No initiative runs yet for this hive.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {runs.map((run) => {
        const isExpanded = expandedRunId === run.id;
        const detail = runDetails[run.id];
        const triggerLabel = formatTriggerSource(run.trigger, run.triggerRef);

        return (
          <article
            key={run.id}
            className="rounded-2xl border border-amber-200/70 bg-white/80 p-5 shadow-sm shadow-amber-950/5 dark:border-white/[0.08] dark:bg-white/[0.03]"
          >
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.16em] text-amber-700/70 dark:text-amber-300/65">
                  <span>{formatDateTime(run.startedAt)}</span>
                  <span className="h-1 w-1 rounded-full bg-amber-500/60" aria-hidden="true" />
                  <span>{triggerLabel}</span>
                </div>
                <h2 className="text-lg font-semibold text-amber-950 dark:text-amber-50">
                  Initiative run
                </h2>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  Status {run.status}. Completed {formatDateTime(run.completedAt)}.
                </p>
              </div>

              <button
                type="button"
                onClick={() => toggleRun(run.id)}
                aria-expanded={isExpanded}
                className="rounded-full border border-amber-300/80 px-4 py-2 text-sm font-medium text-amber-950 transition hover:bg-amber-100/80 dark:border-amber-400/20 dark:text-amber-100 dark:hover:bg-amber-500/10"
              >
                {isExpanded ? "Hide details" : "View details"}
              </button>
            </div>

            <dl className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl bg-amber-50/80 p-3 dark:bg-amber-500/5">
                <dt className="text-xs uppercase tracking-[0.14em] text-amber-700/70 dark:text-amber-300/65">
                  Candidates
                </dt>
                <dd className="mt-1 text-lg font-semibold text-amber-950 dark:text-amber-50">
                  {run.evaluatedCandidates}
                </dd>
              </div>
              <div className="rounded-xl bg-amber-50/80 p-3 dark:bg-amber-500/5">
                <dt className="text-xs uppercase tracking-[0.14em] text-amber-700/70 dark:text-amber-300/65">
                  Tasks created
                </dt>
                <dd className="mt-1 text-lg font-semibold text-amber-950 dark:text-amber-50">
                  {run.createdCount}
                </dd>
              </div>
              <div className="rounded-xl bg-amber-50/80 p-3 dark:bg-amber-500/5">
                <dt className="text-xs uppercase tracking-[0.14em] text-amber-700/70 dark:text-amber-300/65">
                  Suppressed / noop
                </dt>
                <dd className="mt-1 text-lg font-semibold text-amber-950 dark:text-amber-50">
                  {run.suppressedCount} / {run.noopCount}
                </dd>
              </div>
              <div className="rounded-xl bg-amber-50/80 p-3 dark:bg-amber-500/5">
                <dt className="text-xs uppercase tracking-[0.14em] text-amber-700/70 dark:text-amber-300/65">
                  Errored
                </dt>
                <dd className="mt-1 text-lg font-semibold text-amber-950 dark:text-amber-50">
                  {run.runFailures}
                </dd>
              </div>
            </dl>

            <div className="mt-4 flex flex-wrap gap-2">
              {run.topSuppressionReasons.length === 0 ? (
                <span className="text-sm text-zinc-500 dark:text-zinc-400">No suppression reasons recorded.</span>
              ) : (
                run.topSuppressionReasons.map((reason) => (
                  <span
                    key={`${run.id}-${reason.reason}`}
                    className="rounded-full bg-amber-100/80 px-3 py-1 text-xs text-amber-950 dark:bg-amber-400/10 dark:text-amber-100"
                  >
                    {formatReason(reason.reason)} x{reason.count}
                  </span>
                ))
              )}
            </div>

            {run.failureReason ? (
              <p className="mt-4 text-sm text-red-700 dark:text-red-300">Failure: {run.failureReason}</p>
            ) : null}

            {isExpanded ? (
              <div className="mt-5 border-t border-amber-200/70 pt-5 dark:border-white/[0.08]">
                {detailsLoadingId === run.id && !detail ? (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading run details...</p>
                ) : detail?.decisions.length ? (
                  <div className="space-y-3">
                    {detail.decisions.map((decision) => (
                      <div
                        key={decision.id}
                        className="rounded-xl border border-amber-200/70 bg-amber-50/40 p-4 dark:border-white/[0.08] dark:bg-white/[0.02]"
                      >
                        <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded-full bg-amber-100/80 px-2.5 py-1 text-xs font-medium text-amber-950 dark:bg-amber-400/10 dark:text-amber-100">
                                {decision.candidate_kind}
                              </span>
                              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${actionBadgeClass(decision.action_taken)}`}>
                                {decision.action_taken}
                              </span>
                            </div>
                            <div className="text-sm text-zinc-700 dark:text-zinc-300">
                              {decision.target_goal_id ? (
                                <Link
                                  href={`/goals/${decision.target_goal_id}`}
                                  className="font-medium text-blue-700 hover:underline dark:text-blue-300"
                                >
                                  {decision.target_goal_title ?? decision.target_goal_id}
                                </Link>
                              ) : (
                                <span className="font-medium text-amber-950 dark:text-amber-50">
                                  {decision.target_goal_title ?? "Unknown goal"}
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="text-sm text-zinc-700 dark:text-zinc-300">
                            <p className="font-medium text-amber-950 dark:text-amber-50">Created work</p>
                            {decision.created_task_id ? (
                              <p className="mt-1">
                                Task:{" "}
                                <Link
                                  href={`/tasks/${decision.created_task_id}`}
                                  className="font-medium text-blue-700 hover:underline dark:text-blue-300"
                                >
                                  {decision.created_task_title ?? "View created task"}
                                </Link>
                              </p>
                            ) : null}
                            {!decision.created_task_id && decision.created_goal_id ? (
                              <p className="mt-1">
                                Goal:{" "}
                                <Link
                                  href={`/goals/${decision.created_goal_id}`}
                                  className="font-medium text-blue-700 hover:underline dark:text-blue-300"
                                >
                                  {decision.created_goal_title ?? "View created goal"}
                                </Link>
                              </p>
                            ) : null}
                            {!decision.created_task_id && !decision.created_goal_id ? (
                              <p className="mt-1 text-zinc-500 dark:text-zinc-400">No work item created.</p>
                            ) : null}
                          </div>
                        </div>

                        {(decision.suppression_reasons ?? []).length > 0 ? (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {(decision.suppression_reasons ?? []).map((reason) => (
                              <span
                                key={`${decision.id}-${reason}`}
                                className="rounded-full bg-amber-100/80 px-3 py-1 text-xs text-amber-950 dark:bg-amber-400/10 dark:text-amber-100"
                              >
                                {formatReason(reason)}
                              </span>
                            ))}
                          </div>
                        ) : null}

                        <div className="mt-3 rounded-lg bg-white/70 p-3 text-sm text-zinc-700 dark:bg-white/[0.03] dark:text-zinc-300">
                          <p className="font-medium text-amber-950 dark:text-amber-50">Classified outcome</p>
                          <p className="mt-1">
                            Work item type:{" "}
                            <span className="font-medium text-amber-950 dark:text-amber-50">
                              {decision.classified_outcome?.workItemType
                                ? toTitleCase(decision.classified_outcome.workItemType)
                                : "Not recorded"}
                            </span>
                          </p>
                          <p className="mt-1">
                            Classified role:{" "}
                            <span className="font-medium text-amber-950 dark:text-amber-50">
                              {decision.classified_outcome?.classifiedRole ?? "Not recorded"}
                            </span>
                          </p>
                          <p className="mt-1">
                            Classification:{" "}
                            {decision.classified_outcome?.classification ? (
                              <span>
                                {[
                                  decision.classified_outcome.classification.provider,
                                  decision.classified_outcome.classification.model,
                                  typeof decision.classified_outcome.classification.confidence === "number"
                                    ? formatConfidence(decision.classified_outcome.classification.confidence)
                                    : null,
                                  decision.classified_outcome.classification.role,
                                  decision.classified_outcome.classification.usedFallback ? "fallback" : null,
                                ].filter(Boolean).join(" • ") || "Recorded"}
                              </span>
                            ) : (
                              <span>Not recorded</span>
                            )}
                          </p>
                          {decision.classified_outcome?.classification?.reasoning ? (
                            <p className="mt-1 whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">
                              {decision.classified_outcome.classification.reasoning}
                            </p>
                          ) : null}
                        </div>

                        <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
                          {decision.rationale}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-zinc-500 dark:text-zinc-400">No per-candidate decisions recorded for this run.</p>
                )}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}
