"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useHiveContext } from "@/components/hive-context";

type PipelineStep = {
  id: string;
  order: number;
  slug: string;
  name: string;
  roleSlug: string;
  duty: string;
  qaRequired: boolean;
};

type PipelineRunStep = PipelineStep & {
  stepRunId: string | null;
  taskId: string | null;
  status: string;
  resultSummary: string | null;
  current: boolean;
  completedAt: string | null;
};

type PipelineTemplate = {
  id: string;
  scope: string;
  hiveId: string | null;
  slug: string;
  name: string;
  description: string | null;
  department: string;
  version: number;
  active: boolean;
  stepCount: number;
  steps: PipelineStep[];
};

type PipelineRun = {
  id: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  status: string;
  sourceTaskId: string | null;
  goalId: string | null;
  projectId: string | null;
  supervisorHandoff: string | null;
  currentStepId: string | null;
  currentStepName: string | null;
  currentStepOrder: number | null;
  steps: PipelineRunStep[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type PipelinesResponse = {
  templates: PipelineTemplate[];
  runs: PipelineRun[];
};

type TimelineStep = PipelineStep & {
  status?: string;
  resultSummary?: string | null;
  taskId?: string | null;
  current?: boolean;
};

type ProcedureStepForm = {
  order: number;
  slug: string;
  name: string;
  roleSlug: string;
  duty: string;
  qaRequired: boolean;
};

type ProcedureFormState = {
  templateId?: string;
  name: string;
  slug: string;
  department: string;
  description: string;
  active: boolean;
  steps: ProcedureStepForm[];
};

const RUN_STATUS_CLASS: Record<string, string> = {
  active: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-200",
  complete: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-200",
  failed: "border-red-200 bg-red-50 text-red-800 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200",
  cancelled: "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300",
};

function stepVisualState(step: TimelineStep, index: number, currentIndex: number, runStatus?: string) {
  if (step.status === "failed") return "failed";
  if (step.current || step.status === "running") return "current";
  if (step.status === "complete" || step.status === "skipped") return "complete";
  if (runStatus === "complete") return "complete";
  if (currentIndex >= 0 && index < currentIndex) return "complete";
  return "pending";
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusLabel(status?: string, current?: boolean) {
  if (current) return "Current";
  if (!status) return "Pending";
  return status.replaceAll("_", " ");
}

function PipelineTimeline({
  steps,
  runStatus,
  emptyLabel = "No steps configured yet.",
}: {
  steps: TimelineStep[];
  runStatus?: string;
  emptyLabel?: string;
}) {
  const currentIndex = steps.findIndex((step) => step.current || step.status === "running");

  if (steps.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0" aria-label="Procedure step timeline">
      <ol className="flex min-w-max items-start gap-0">
        {steps.map((step, index) => {
          const state = stepVisualState(step, index, currentIndex, runStatus);
          const isComplete = state === "complete";
          const isCurrent = state === "current";
          const isFailed = state === "failed";
          const connectorDone = isComplete || (currentIndex > 0 && index < currentIndex);

          return (
            <li key={step.id} className="flex items-start">
              <div className="w-44 shrink-0">
                <div className="flex items-center">
                  <div
                    className={`flex h-11 w-11 items-center justify-center rounded-full border-2 text-sm font-semibold shadow-sm ${
                      isFailed
                        ? "border-red-500 bg-red-500 text-white"
                        : isCurrent
                          ? "border-amber-400 bg-amber-300 text-amber-950 ring-4 ring-amber-200 dark:ring-amber-900/50"
                          : isComplete
                            ? "border-emerald-500 bg-emerald-500 text-white"
                            : "border-zinc-300 bg-white text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400"
                    }`}
                    title={`Step ${step.order}: ${statusLabel(step.status, step.current)}`}
                  >
                    {isComplete ? "✓" : isFailed ? "!" : step.order}
                  </div>
                  {index < steps.length - 1 ? (
                    <div
                      className={`h-1 flex-1 rounded-full ${
                        connectorDone
                          ? "bg-emerald-400 dark:bg-emerald-600"
                          : "bg-zinc-200 dark:bg-zinc-800"
                      }`}
                    />
                  ) : null}
                </div>
                <div className="mt-3 pr-4">
                  <div className="text-sm font-medium text-zinc-950 dark:text-zinc-100">{step.name}</div>
                  <div className="mt-1 text-xs capitalize text-zinc-500 dark:text-zinc-400">
                    {statusLabel(step.status, step.current)} · {step.roleSlug}
                  </div>
                  {step.qaRequired ? (
                    <div className="mt-2 inline-flex rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-200">
                      QA required
                    </div>
                  ) : null}
                  {step.resultSummary ? (
                    <p className="mt-2 line-clamp-2 text-xs text-zinc-600 dark:text-zinc-300">{step.resultSummary}</p>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function emptyStep(order: number): ProcedureStepForm {
  return {
    order,
    slug: "",
    name: "",
    roleSlug: "",
    duty: "",
    qaRequired: false,
  };
}

function formFromTemplate(template?: PipelineTemplate): ProcedureFormState {
  if (!template) {
    return {
      name: "",
      slug: "",
      department: "operations",
      description: "",
      active: false,
      steps: [emptyStep(1)],
    };
  }
  return {
    templateId: template.id,
    name: template.name,
    slug: template.slug,
    department: template.department,
    description: template.description ?? "",
    active: template.active !== false,
    steps: template.steps.length > 0
      ? template.steps.map((step, index) => ({
        order: index + 1,
        slug: step.slug,
        name: step.name,
        roleSlug: step.roleSlug,
        duty: step.duty,
        qaRequired: step.qaRequired,
      }))
      : [emptyStep(1)],
  };
}

function renumberSteps(steps: ProcedureStepForm[]) {
  return steps.map((step, index) => ({ ...step, order: index + 1 }));
}

function ProcedureTemplateForm({
  initial,
  saving,
  onCancel,
  onSave,
}: {
  initial?: PipelineTemplate;
  saving: boolean;
  onCancel: () => void;
  onSave: (form: ProcedureFormState) => Promise<void>;
}) {
  const [form, setForm] = useState<ProcedureFormState>(() => formFromTemplate(initial));

  const updateStep = (index: number, patch: Partial<ProcedureStepForm>) => {
    setForm((current) => ({
      ...current,
      steps: current.steps.map((step, stepIndex) => (stepIndex === index ? { ...step, ...patch } : step)),
    }));
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    setForm((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.steps.length) return current;
      const steps = [...current.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...current, steps: renumberSteps(steps) };
    });
  };

  const removeStep = (index: number) => {
    setForm((current) => ({
      ...current,
      steps: renumberSteps(current.steps.filter((_, stepIndex) => stepIndex !== index)),
    }));
  };

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-100">
          {form.templateId ? "Edit procedure template" : "Create procedure template"}
        </h2>
      </div>
      <form
        aria-label="Procedure template form"
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(form);
        }}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
            Name
            <input
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            />
          </label>
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
            Slug
            <input
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              value={form.slug}
              onChange={(event) => setForm((current) => ({ ...current, slug: event.target.value }))}
            />
          </label>
          <label className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
            Department
            <input
              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
              value={form.department}
              onChange={(event) => setForm((current) => ({ ...current, department: event.target.value }))}
            />
          </label>
          <label className="flex items-center gap-2 self-end rounded-lg border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 dark:border-zinc-800 dark:text-zinc-200">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))}
            />
            Save as approved
          </label>
        </div>
        <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200">
          Description
          <textarea
            className="mt-1 min-h-20 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            value={form.description}
            onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
          />
        </label>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold uppercase text-zinc-500 dark:text-zinc-400">Steps</h3>
            <button
              type="button"
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:border-amber-400 dark:border-zinc-700 dark:text-zinc-200"
              onClick={() => setForm((current) => ({ ...current, steps: [...current.steps, emptyStep(current.steps.length + 1)] }))}
            >
              Add step
            </button>
          </div>
          {form.steps.map((step, index) => (
            <div key={`${step.order}-${index}`} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Step {index + 1}</div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    aria-label="Move step up"
                    disabled={index === 0}
                    className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 disabled:text-zinc-400 dark:border-zinc-700 dark:text-zinc-200"
                    onClick={() => moveStep(index, -1)}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    aria-label="Move step down"
                    disabled={index === form.steps.length - 1}
                    className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-700 disabled:text-zinc-400 dark:border-zinc-700 dark:text-zinc-200"
                    onClick={() => moveStep(index, 1)}
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    aria-label="Remove step"
                    className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-700 dark:border-red-900/70 dark:text-red-200"
                    onClick={() => removeStep(index)}
                  >
                    Remove
                  </button>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                  Step {index + 1} name
                  <input
                    className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    value={step.name}
                    onChange={(event) => updateStep(index, { name: event.target.value })}
                  />
                </label>
                <label className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                  Step {index + 1} role slug
                  <input
                    className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    value={step.roleSlug}
                    onChange={(event) => updateStep(index, { roleSlug: event.target.value })}
                  />
                </label>
              </div>
              <label className="mt-3 block text-sm font-medium text-zinc-700 dark:text-zinc-200">
                Step {index + 1} duty
                <textarea
                  className="mt-1 min-h-16 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                  value={step.duty}
                  onChange={(event) => updateStep(index, { duty: event.target.value })}
                />
              </label>
              <label className="mt-3 flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-200">
                <input
                  type="checkbox"
                  checked={step.qaRequired}
                  onChange={(event) => updateStep(index, { qaRequired: event.target.checked })}
                />
                QA required
              </label>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:text-zinc-200"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-zinc-950 px-3 py-2 text-sm font-medium text-white disabled:bg-zinc-400 dark:bg-zinc-100 dark:text-zinc-950"
          >
            {saving ? "Saving..." : "Save procedure"}
          </button>
        </div>
      </form>
    </section>
  );
}

function TemplateCard({
  template,
  onEdit,
  onArchive,
  onDelete,
}: {
  template: PipelineTemplate;
  onEdit: (template: PipelineTemplate) => void;
  onArchive: (template: PipelineTemplate) => void;
  onDelete: (template: PipelineTemplate) => void;
}) {
  const applicability =
    template.active === false
      ? "Suggested draft procedure - candidate only; not mandatory until owner approved."
      : "Approved repeatable procedure - use when a mandatory owner process applies or this governed process materially fits.";
  const statusLabel = template.active === false ? "Draft" : "Approved";
  const statusClass = template.active === false
    ? "border-zinc-300 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
    : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/70 dark:bg-emerald-950/40 dark:text-emerald-200";

  return (
    <article className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {template.department} · v{template.version} · {template.scope}
          </div>
          <h3 className="mt-1 text-lg font-semibold text-zinc-950 dark:text-zinc-100">{template.name}</h3>
          <p className="mt-1 max-w-3xl text-sm font-medium text-zinc-700 dark:text-zinc-200">
            {applicability}
          </p>
          {template.description ? (
            <p className="mt-1 max-w-3xl text-sm text-zinc-600 dark:text-zinc-300">{template.description}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <span className={`rounded-full border px-3 py-1 text-xs font-medium ${statusClass}`}>
            {statusLabel}
          </span>
          <span className="rounded-full border border-zinc-200 px-3 py-1 text-xs text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
            {template.stepCount} steps
          </span>
          <button
            type="button"
            aria-label={`Edit ${template.name}`}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-700 hover:border-amber-400 dark:border-zinc-700 dark:text-zinc-200"
            onClick={() => onEdit(template)}
          >
            Edit
          </button>
          <button
            type="button"
            aria-label={`Archive ${template.name}`}
            disabled={template.active === false}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-700 hover:border-amber-400 disabled:text-zinc-400 dark:border-zinc-700 dark:text-zinc-200"
            onClick={() => onArchive(template)}
          >
            Archive
          </button>
          <button
            type="button"
            aria-label={`Delete ${template.name}`}
            className="rounded-full border border-red-200 px-3 py-1 text-xs text-red-700 hover:border-red-400 dark:border-red-900/70 dark:text-red-200"
            onClick={() => onDelete(template)}
          >
            Delete
          </button>
        </div>
      </div>
      <PipelineTimeline steps={template.steps} />
    </article>
  );
}

function RunCard({ run, template }: { run: PipelineRun; template?: PipelineTemplate }) {
  const statusClass = RUN_STATUS_CLASS[run.status] ?? RUN_STATUS_CLASS.cancelled;
  const fallbackSteps = useMemo(() => {
    if (run.steps.length > 0) return run.steps;
    return (template?.steps ?? []).map((step) => ({
      ...step,
      current: step.id === run.currentStepId,
      status: step.id === run.currentStepId ? "running" : "pending",
      resultSummary: null,
      taskId: null,
    }));
  }, [run.currentStepId, run.steps, template?.steps]);

  return (
    <article className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Run {run.id.slice(0, 8)} · Template v{run.templateVersion}
          </div>
          <h2 className="mt-1 text-xl font-semibold text-zinc-950 dark:text-zinc-100">{run.templateName}</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
            Current: <span className="font-medium text-zinc-900 dark:text-zinc-100">{run.currentStepName ?? "No active step"}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-full border px-3 py-1 font-medium capitalize ${statusClass}`}>{run.status}</span>
          <span className="rounded-full border border-zinc-200 px-3 py-1 text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
            Updated {formatDate(run.updatedAt)}
          </span>
        </div>
      </div>

      <PipelineTimeline steps={fallbackSteps} runStatus={run.status} />

      {run.supervisorHandoff ? (
        <div className="mt-4 rounded-lg bg-zinc-50 p-3 text-sm text-zinc-700 dark:bg-zinc-900/70 dark:text-zinc-300">
          <span className="font-medium">Supervisor handoff:</span> {run.supervisorHandoff}
        </div>
      ) : null}
    </article>
  );
}

export default function PipelinesPage() {
  const { selected, loading: hiveLoading } = useHiveContext();
  const [data, setData] = useState<PipelinesResponse>({ templates: [], runs: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<PipelineTemplate | undefined>();
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [saving, setSaving] = useState(false);
  const selectedId = selected?.id;

  const fetchPipelines = useCallback(async () => {
    if (!selectedId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/pipelines", window.location.origin);
      url.searchParams.set("hiveId", selectedId);
      url.searchParams.set("includeInactive", "true");
      const response = await fetch(url.toString());
      if (!response.ok) throw new Error(`Request failed with ${response.status}`);
      const body = await response.json();
      setData(body.data ?? { templates: [], runs: [] });
    } catch (err) {
      setData({ templates: [], runs: [] });
      setError(err instanceof Error ? err.message : "Unable to load business procedures.");
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    if (!selected) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    const run = async () => {
      await fetchPipelines();
      if (cancelled) return;
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [fetchPipelines, selectedId]);

  const saveProcedure = async (form: ProcedureFormState) => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/pipelines", {
        method: form.templateId ? "PATCH" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hiveId: selected.id,
          templateId: form.templateId,
          name: form.name,
          slug: form.slug,
          department: form.department,
          description: form.description,
          active: form.active,
          steps: form.steps,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `Request failed with ${response.status}`);
      setCreatingTemplate(false);
      setEditingTemplate(undefined);
      await fetchPipelines();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save procedure template.");
    } finally {
      setSaving(false);
    }
  };

  const archiveTemplate = async (template: PipelineTemplate) => {
    if (!selected) return;
    setError(null);
    try {
      const response = await fetch("/api/pipelines", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId: selected.id, templateId: template.id, active: false }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `Request failed with ${response.status}`);
      await fetchPipelines();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to archive procedure template.");
    }
  };

  const deleteTemplate = async (template: PipelineTemplate) => {
    if (!selected) return;
    setError(null);
    try {
      const response = await fetch("/api/pipelines", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId: selected.id, templateId: template.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `Request failed with ${response.status}`);
      await fetchPipelines();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete procedure template.");
    }
  };

  const templatesById = useMemo(
    () => new Map(data.templates.map((template) => [template.id, template])),
    [data.templates],
  );
  const approvedTemplates = useMemo(
    () => data.templates.filter((template) => template.active !== false),
    [data.templates],
  );
  const draftTemplates = useMemo(
    () => data.templates.filter((template) => template.active === false),
    [data.templates],
  );

  if (hiveLoading) return <p className="text-zinc-400">Loading...</p>;
  if (!selected) return <p className="text-zinc-400">No hive selected.</p>;

  const hasRuns = data.runs.length > 0;
  const hasTemplates = data.templates.length > 0;
  const hasAnyProcedureActivity = hasRuns || hasTemplates;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-950 dark:text-zinc-100">Business procedures</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
            Owner-approved, repeatable procedures for process-bound work in {selected.name}. Use them when a mandatory owner process applies; supervisors stay outcome-led for other work.
            Procedures are not the default agent workflow. Draft or suggested procedures stay optional until owner approved.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
            {data.runs.length} runs · {approvedTemplates.length} approved · {draftTemplates.length} draft
          </div>
          <button
            type="button"
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:border-amber-400 dark:border-zinc-700 dark:text-zinc-200"
            onClick={() => {
              setCreatingTemplate(true);
              setEditingTemplate(undefined);
            }}
          >
            Create procedure
          </button>
        </div>
      </div>

      {creatingTemplate || editingTemplate ? (
        <ProcedureTemplateForm
          key={editingTemplate?.id ?? "new"}
          initial={editingTemplate}
          saving={saving}
          onCancel={() => {
            setCreatingTemplate(false);
            setEditingTemplate(undefined);
          }}
          onSave={saveProcedure}
        />
      ) : null}

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200">
          Unable to load business procedures. {error}
        </div>
      ) : loading ? (
        <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
          Loading business procedures...
        </div>
      ) : (
        <>
          {!hasAnyProcedureActivity ? (
            <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
              <h2 className="text-lg font-semibold text-zinc-950 dark:text-zinc-100">Clean procedure slate</h2>
              <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-300">
                This hive does not have approved procedures, draft procedure assets, or recent runs yet. Capture a workflow or import an SOP to create draft reusable assets, then approve only the procedures that should govern process-bound work.
              </p>
            </div>
          ) : null}

          <section className="space-y-3" aria-labelledby="capture-import-heading">
            <div>
              <h2 id="capture-import-heading" className="text-lg font-semibold text-zinc-950 dark:text-zinc-100">
                Capture and import
              </h2>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
                Bring in real operating steps as draft reusable procedure assets. Captured material does not become mandatory until an owner approves it.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Link
                href="/setup/workflow-capture"
                className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-amber-300 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-amber-700"
              >
                <h3 className="text-base font-semibold text-zinc-950 dark:text-zinc-100">Screen capture</h3>
                <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
                  Record a browser workflow, review the captured steps, and turn the evidence into a draft procedure candidate.
                </p>
              </Link>
              <Link
                href="/setup/sop-importer"
                className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-amber-300 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-amber-700"
              >
                <h3 className="text-base font-semibold text-zinc-950 dark:text-zinc-100">SOP import</h3>
                <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
                  Paste or import written procedure notes so they can be normalized into a draft procedure asset.
                </p>
              </Link>
            </div>
          </section>

          <section className="space-y-4" aria-labelledby="procedure-library-heading">
            <div>
              <h2 id="procedure-library-heading" className="text-lg font-semibold text-zinc-950 dark:text-zinc-100">
                Procedure library
              </h2>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
                Approved procedures are available for process-bound work. Draft and inactive procedures are visible for owner review but are not executable.
              </p>
            </div>

            {hasTemplates ? (
              <div className="space-y-4">
                {approvedTemplates.length > 0 ? (
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold uppercase text-zinc-500 dark:text-zinc-400">Approved</h3>
                    {approvedTemplates.map((template) => (
                      <TemplateCard
                        key={template.id}
                        template={template}
                        onEdit={(target) => {
                          setCreatingTemplate(false);
                          setEditingTemplate(target);
                        }}
                        onArchive={archiveTemplate}
                        onDelete={deleteTemplate}
                      />
                    ))}
                  </div>
                ) : null}
                {draftTemplates.length > 0 ? (
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold uppercase text-zinc-500 dark:text-zinc-400">Draft or inactive</h3>
                    {draftTemplates.map((template) => (
                      <TemplateCard
                        key={template.id}
                        template={template}
                        onEdit={(target) => {
                          setCreatingTemplate(false);
                          setEditingTemplate(target);
                        }}
                        onArchive={archiveTemplate}
                        onDelete={deleteTemplate}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-zinc-300 bg-white p-5 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
                No procedure templates yet. Use capture or import to create draft assets, then approve procedures that should be reusable and process-bound.
              </div>
            )}
          </section>

          <section className="space-y-4" aria-labelledby="procedure-runs-heading">
            <div>
              <h2 id="procedure-runs-heading" className="text-lg font-semibold text-zinc-950 dark:text-zinc-100">
                Recent procedure runs
              </h2>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
                Runs show procedures already selected for process-bound work.
              </p>
            </div>
            {hasRuns ? (
              data.runs.map((run) => (
                <RunCard key={run.id} run={run} template={templatesById.get(run.templateId)} />
              ))
            ) : (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-200">
                No procedure runs yet. Available procedures can be inspected in the library; supervisors should start a run only when a mandatory or owner-approved process applies.
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
