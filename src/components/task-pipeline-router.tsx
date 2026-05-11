"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type PipelineTemplate = {
  id: string;
  scope?: string;
  active?: boolean;
  name: string;
  department: string;
  description: string | null;
  stepCount: number;
  steps?: Array<{ id: string; name: string; roleSlug: string; order: number }>;
};

type PipelineRun = {
  id: string;
  status: string;
  sourceTaskId: string | null;
  templateName: string;
  currentStepName: string | null;
};

type PipelinesResponse = {
  data?: {
    templates?: PipelineTemplate[];
    runs?: PipelineRun[];
  };
  error?: string;
};

const ACTIVE_RUN_STATUSES = new Set(["active", "pending", "running"]);

function procedureApplicabilityCopy(template: PipelineTemplate) {
  if (template.active === false) {
    return {
      label: "Suggested draft procedure",
      description: "Candidate only; not mandatory until owner approved.",
    };
  }

  return {
    label: "Approved repeatable procedure",
    description:
      template.scope === "hive"
        ? "Owner-approved for this hive. Use only when a mandatory owner process applies or this governed repeatable process materially fits the work."
        : "Owner-approved reusable procedure. Use only when a mandatory owner process applies or this governed repeatable process materially fits the work.",
  };
}

export function TaskPipelineRouter({
  hiveId,
  taskId,
  taskTitle,
}: {
  hiveId: string;
  taskId: string;
  taskTitle: string;
}) {
  const [templates, setTemplates] = useState<PipelineTemplate[]>([]);
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedRunId, setStartedRunId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadPipelines() {
      setLoading(true);
      setError(null);
      try {
        const url = new URL("/api/pipelines", window.location.origin);
        url.searchParams.set("hiveId", hiveId);
        const response = await fetch(url.toString());
        const body = (await response.json()) as PipelinesResponse;
        if (!response.ok) throw new Error(body.error || `Request failed with ${response.status}`);
        const nextTemplates = body.data?.templates ?? [];
        if (!cancelled) {
          setTemplates(nextTemplates);
          setRuns(body.data?.runs ?? []);
          setSelectedTemplateId((current) => current || nextTemplates[0]?.id || "");
        }
      } catch (err) {
        if (!cancelled) {
          setTemplates([]);
          setRuns([]);
          setError(err instanceof Error ? err.message : "Unable to load business procedures.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPipelines();
    return () => {
      cancelled = true;
    };
  }, [hiveId]);

  const activeRun = useMemo(
    () => runs.find((run) => run.sourceTaskId === taskId && ACTIVE_RUN_STATUSES.has(run.status)),
    [runs, taskId],
  );

  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? null;
  const disabled = loading || submitting || templates.length === 0 || Boolean(activeRun) || !selectedTemplateId;

  async function startPipeline() {
    if (disabled) return;
    setSubmitting(true);
    setError(null);
    setStartedRunId(null);
    try {
      const response = await fetch("/api/pipelines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId, templateId: selectedTemplateId, sourceTaskId: taskId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Request failed with ${response.status}`);
      setStartedRunId(body.data?.runId ?? "created");
      setRuns((current) => [
        {
          id: body.data?.runId ?? "created",
          status: "active",
          sourceTaskId: taskId,
          templateName: selectedTemplate?.name ?? "Business procedure",
          currentStepName: selectedTemplate?.steps?.[0]?.name ?? null,
        },
        ...current,
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start business procedure.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-xl border border-amber-200/70 bg-gradient-to-br from-amber-50 via-white to-zinc-50 p-4 shadow-sm dark:border-amber-500/20 dark:from-amber-950/25 dark:via-zinc-950 dark:to-zinc-950">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-700 dark:text-amber-300">
            Governed procedure routing
          </p>
          <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-50">Business procedures</h2>
          <p className="max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
            Start a governed procedure for “{taskTitle}” only when the work is covered by a mandatory owner process or an approved repeatable procedure. Suggested drafts are candidates only; they are not mandatory until owner approved.
          </p>
        </div>
        <Link
          href="/pipelines"
          className="inline-flex w-fit items-center rounded-md border border-zinc-300 px-3 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100 dark:border-white/10 dark:text-zinc-200 dark:hover:bg-white/5"
        >
          View procedures
        </Link>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <label className="space-y-1.5">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Business procedure</span>
          <select
            value={selectedTemplateId}
            onChange={(event) => setSelectedTemplateId(event.target.value)}
            disabled={loading || templates.length === 0 || Boolean(activeRun)}
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-500/20 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-100 dark:disabled:bg-zinc-900/60"
            aria-label="Business procedure"
          >
            {loading ? <option>Loading business procedures...</option> : null}
            {!loading && templates.length === 0 ? <option>No business procedures available</option> : null}
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} · {template.stepCount} steps
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={startPipeline}
          disabled={disabled}
          className="inline-flex justify-center rounded-lg bg-zinc-950 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-500 dark:bg-amber-400 dark:text-zinc-950 dark:hover:bg-amber-300 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-500"
        >
          {submitting ? "Starting..." : "Start procedure"}
        </button>
      </div>

      {selectedTemplate && !activeRun ? (
        <div className="mt-3 rounded-lg border border-zinc-200 bg-white/70 p-3 text-sm text-zinc-600 dark:border-white/10 dark:bg-white/[0.03] dark:text-zinc-300">
          <div className="font-medium text-zinc-900 dark:text-zinc-100">
            {procedureApplicabilityCopy(selectedTemplate).label}
          </div>
          <p className="mt-1">{procedureApplicabilityCopy(selectedTemplate).description}</p>
          <div className="mt-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {selectedTemplate.department}
          </div>
          {selectedTemplate.description ? <p className="mt-1">{selectedTemplate.description}</p> : null}
        </div>
      ) : null}

      {activeRun ? (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-100/70 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          Already routed through governed procedure <strong>{activeRun.templateName}</strong>
          {activeRun.currentStepName ? <> — current step: {activeRun.currentStepName}</> : null}. Open the procedures board instead of starting a duplicate run.
        </div>
      ) : null}

      {startedRunId ? (
        <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100">
          Business procedure started. <Link href="/pipelines" className="font-semibold underline">View it on the procedures board</Link>.
        </div>
      ) : null}

      {error ? (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      ) : null}
    </section>
  );
}
