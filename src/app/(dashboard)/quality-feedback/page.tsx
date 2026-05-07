"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useHiveContext } from "@/components/hive-context";

type QualityFeedbackDecision = {
  id: string;
  taskId: string | null;
  title: string;
  context: string;
  recommendation: string | null;
  status: string;
  ownerResponse: string | null;
  createdAt: string;
  resolvedAt: string | null;
  task: {
    id: string;
    title: string;
    role: string | null;
    completedAt: string | null;
  } | null;
};

type ParsedFeedback = {
  response: string;
  rating: number | null;
  comment: string | null;
};

function parseFeedback(value: string | null): ParsedFeedback {
  if (!value) return { response: "", rating: null, comment: null };
  try {
    const parsed = JSON.parse(value) as Partial<ParsedFeedback>;
    return {
      response: typeof parsed.response === "string" ? parsed.response : value,
      rating: typeof parsed.rating === "number" ? parsed.rating : null,
      comment: typeof parsed.comment === "string" ? parsed.comment : null,
    };
  } catch {
    return { response: value, rating: null, comment: null };
  }
}

function formatDate(value: string | null) {
  if (!value) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

async function fetchFeedback(
  hiveId: string,
  status: "pending" | "resolved",
  qaRunId: string | null,
) {
  const qaParams = qaRunId
    ? `&qaFixtures=true&qaRunId=${encodeURIComponent(qaRunId)}`
    : "";
  const res = await fetch(
    `/api/decisions?hiveId=${hiveId}&status=${status}&includeKinds=task_quality_feedback&limit=${status === "pending" ? 50 : 20}${qaParams}`,
  );
  if (!res.ok) throw new Error("Failed to load quality feedback");
  const body = await res.json();
  return (body.data ?? []) as QualityFeedbackDecision[];
}

function QualityFeedbackPageInner() {
  const searchParams = useSearchParams();
  const { selected, hives, loading: hivesLoading } = useHiveContext();
  const selectedHiveId = searchParams.get("hiveId") ?? selected?.id ?? hives[0]?.id ?? null;
  const qaRunId = searchParams.get("qaRunId");
  const [pending, setPending] = useState<QualityFeedbackDecision[]>([]);
  const [resolved, setResolved] = useState<QualityFeedbackDecision[]>([]);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);

  const loadFeedback = useCallback(async () => {
    if (!selectedHiveId) return;
    setLoading(true);
    setError(null);
    try {
      const [pendingRows, resolvedRows] = await Promise.all([
        fetchFeedback(selectedHiveId, "pending", qaRunId),
        fetchFeedback(selectedHiveId, "resolved", qaRunId),
      ]);
      setPending(pendingRows);
      setResolved(resolvedRows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load quality feedback");
    } finally {
      setLoading(false);
    }
  }, [qaRunId, selectedHiveId]);

  useEffect(() => {
    if (selectedHiveId) void loadFeedback();
  }, [loadFeedback, selectedHiveId]);

  const selectedTitle = useMemo(() => {
    if (!selectedHiveId) return null;
    return hives.find((hive) => hive.id === selectedHiveId)?.name ?? selected?.name ?? "Active hive";
  }, [hives, selected?.name, selectedHiveId]);

  async function respond(decisionId: string, response: "quality_feedback" | "dismiss_quality_feedback") {
    const rating = ratings[decisionId];
    if (response === "quality_feedback" && !rating) {
      setError("Pick a rating from 1 to 10 before submitting.");
      return;
    }
    setSubmitting(decisionId);
    setError(null);
    try {
      const res = await fetch(`/api/decisions/${decisionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response,
          rating: response === "quality_feedback" ? rating : undefined,
          comment: comments[decisionId] ?? "",
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Failed to submit feedback");
      }
      await loadFeedback();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit feedback");
    } finally {
      setSubmitting(null);
    }
  }

  if (hivesLoading || loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-amber-950 dark:text-amber-100">Quality feedback</h1>
        <p className="text-sm text-amber-700/70 dark:text-amber-300/70">Loading...</p>
      </div>
    );
  }

  if (!selectedHiveId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-amber-950 dark:text-amber-100">Quality feedback</h1>
        <p className="text-sm text-amber-700/70 dark:text-amber-300/70">No hive selected.</p>
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-amber-950 dark:text-amber-100">Quality feedback</h1>
          <p className="mt-1 text-sm text-amber-800/70 dark:text-amber-300/70">
            {selectedTitle} has {pending.length} task{pending.length === 1 ? "" : "s"} waiting for a quality rating.
          </p>
        </div>
        <Link
          href="/decisions"
          className="rounded-md border border-amber-300/70 px-3 py-2 text-sm text-amber-900 transition hover:bg-amber-100 dark:border-white/[0.10] dark:text-amber-100 dark:hover:bg-white/[0.05]"
        >
          Decisions
        </Link>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-100">
          {error}
        </div>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-medium text-amber-950 dark:text-amber-100">Pending ratings</h2>
          <span className="text-sm text-amber-700/70 dark:text-amber-300/70">{pending.length} pending</span>
        </div>

        {pending.length === 0 ? (
          <div className="rounded-lg border border-dashed border-amber-300/70 p-8 text-center text-sm text-amber-700/70 dark:border-white/[0.12] dark:text-amber-300/70">
            No quality feedback is waiting.
          </div>
        ) : (
          <div className="space-y-4">
            {pending.map((decision) => {
              const task = decision.task;
              return (
                <article
                  key={decision.id}
                  className="rounded-lg border border-amber-200 bg-amber-50/70 p-4 dark:border-white/[0.08] dark:bg-card"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-medium text-amber-950 dark:text-amber-50">
                        {task?.title ?? decision.title}
                      </h3>
                      <p className="mt-1 text-xs text-amber-700/70 dark:text-amber-300/70">
                        {task?.role ?? "unknown role"} - completed {formatDate(task?.completedAt ?? null)}
                      </p>
                    </div>
                    {task?.id && (
                      <Link
                        href={`/tasks/${task.id}`}
                        className="rounded-md border border-amber-300/70 px-2.5 py-1.5 text-xs text-amber-900 transition hover:bg-amber-100 dark:border-white/[0.10] dark:text-amber-100 dark:hover:bg-white/[0.05]"
                      >
                        Open task
                      </Link>
                    )}
                  </div>

                  <div className="mt-4 rounded-md bg-white/65 p-3 dark:bg-black/15">
                    <p className="text-xs font-semibold uppercase text-amber-700/70 dark:text-amber-300/70">
                      Prompt context
                    </p>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-amber-950/85 dark:text-amber-50/85">
                      {decision.context}
                    </p>
                  </div>

                  <div className="mt-4 space-y-3">
                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase text-amber-700/70 dark:text-amber-300/70">
                        Rating
                      </p>
                      <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
                        {Array.from({ length: 10 }, (_, index) => index + 1).map((rating) => (
                          <button
                            key={rating}
                            type="button"
                            onClick={() => setRatings((prev) => ({ ...prev, [decision.id]: rating }))}
                            className={`h-9 rounded-md border text-sm font-medium transition ${
                              ratings[decision.id] === rating
                                ? "border-amber-500 bg-amber-500 text-white"
                                : "border-amber-300/70 bg-white/70 text-amber-900 hover:bg-amber-100 dark:border-white/[0.10] dark:bg-black/10 dark:text-amber-100 dark:hover:bg-white/[0.05]"
                            }`}
                          >
                            {rating}
                          </button>
                        ))}
                      </div>
                    </div>

                    <label className="block">
                      <span className="mb-2 block text-xs font-semibold uppercase text-amber-700/70 dark:text-amber-300/70">
                        Comment
                      </span>
                      <textarea
                        value={comments[decision.id] ?? ""}
                        maxLength={2000}
                        onChange={(event) => setComments((prev) => ({
                          ...prev,
                          [decision.id]: event.target.value,
                        }))}
                        className="min-h-24 w-full rounded-md border border-amber-300/70 bg-white/80 p-3 text-sm text-amber-950 outline-none transition focus:border-amber-500 dark:border-white/[0.10] dark:bg-black/20 dark:text-amber-50"
                      />
                    </label>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => respond(decision.id, "quality_feedback")}
                        disabled={submitting === decision.id}
                        className="rounded-md bg-amber-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-amber-600 disabled:opacity-50"
                      >
                        Submit rating
                      </button>
                      <button
                        type="button"
                        onClick={() => respond(decision.id, "dismiss_quality_feedback")}
                        disabled={submitting === decision.id}
                        className="rounded-md border border-amber-300/70 px-4 py-2 text-sm font-medium text-amber-900 transition hover:bg-amber-100 disabled:opacity-50 dark:border-white/[0.10] dark:text-amber-100 dark:hover:bg-white/[0.05]"
                      >
                        No opinion
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-medium text-amber-950 dark:text-amber-100">Recent ratings</h2>
          <span className="text-sm text-amber-700/70 dark:text-amber-300/70">Last {resolved.length}</span>
        </div>
        {resolved.length === 0 ? (
          <div className="rounded-lg border border-dashed border-amber-300/70 p-6 text-sm text-amber-700/70 dark:border-white/[0.12] dark:text-amber-300/70">
            No quality feedback has been resolved yet.
          </div>
        ) : (
          <div className="space-y-2">
            {resolved.map((decision) => {
              const feedback = parseFeedback(decision.ownerResponse);
              return (
                <div
                  key={decision.id}
                  className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-white/[0.08] dark:bg-card"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-amber-950 dark:text-amber-50">
                      {decision.task?.title ?? decision.title}
                    </p>
                    <span className="text-xs text-amber-700/70 dark:text-amber-300/70">
                      {formatDate(decision.resolvedAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-amber-800/80 dark:text-amber-100/80">
                    {feedback.rating ? `Rating ${feedback.rating}/10` : "No opinion"}
                    {feedback.comment ? ` - ${feedback.comment}` : ""}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

export default function QualityFeedbackPage() {
  return (
    <Suspense fallback={<p className="text-sm text-amber-700/70 dark:text-amber-300/70">Loading...</p>}>
      <QualityFeedbackPageInner />
    </Suspense>
  );
}
