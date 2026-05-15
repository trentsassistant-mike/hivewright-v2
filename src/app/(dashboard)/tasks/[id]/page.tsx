import { notFound } from "next/navigation";
import Link from "next/link";
import { sql } from "@/app/api/_lib/db";
import { serializeGoalBudgetStatus } from "@/budget/status";
import { LiveActivityPanel } from "@/components/live-activity-panel";
import { AttachmentsPanel } from "@/components/attachments-panel";
import { TaskPipelineRouter } from "@/components/task-pipeline-router";
import { readLatestCodexEmptyOutputDiagnostic } from "@/runtime-diagnostics/codex-empty-output";
import { readLatestTaskContextProvenance } from "@/provenance/task-context";
import { toPublicUsageSummary } from "@/usage/billable-usage";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  active: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  paused: "bg-amber-100 text-amber-900",
};

type TaskRow = {
  id: string;
  hive_id: string;
  assigned_to: string;
  created_by: string;
  status: string;
  priority: number;
  title: string;
  brief: string;
  goal_id: string | null;
  sprint_number: number | null;
  qa_required: boolean;
  acceptance_criteria: string | null;
  result_summary: string | null;
  retry_count: number;
  doctor_attempts: number;
  failure_reason: string | null;
  usage_details: unknown;
  tokens_input: number | null;
  tokens_output: number | null;
  cost_cents: number | null;
  model_used: string | null;
  goal_budget_cents: number | null;
  goal_spent_cents: number | null;
  goal_budget_state: "ok" | "warning" | "paused" | "hard_stopped" | null;
  goal_budget_warning_triggered_at: Date | null;
  goal_budget_enforced_at: Date | null;
  goal_budget_enforcement_reason: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type WorkProductRow = {
  id: string;
  content: string;
  summary: string | null;
  artifact_kind: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  model_name: string | null;
  model_snapshot: string | null;
  prompt_tokens: number | null;
  output_tokens: number | null;
  cost_cents: number | null;
  created_at: Date;
};

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="grid grid-cols-3 gap-4 py-3 border-b last:border-b-0">
      <dt className="text-sm font-medium text-zinc-500">{label}</dt>
      <dd className="col-span-2 text-sm text-zinc-900 dark:text-zinc-100">{value}</dd>
    </div>
  );
}

function formatSourceClass(sourceClass: string) {
  return sourceClass.replace(/_/g, " ");
}

function formatUsd(cents: number | null, digits = 2) {
  if (cents === null || !Number.isFinite(cents)) return null;
  return `$${(cents / 100).toFixed(digits)}`;
}

function budgetStateLabel(state: "ok" | "warning" | "paused" | "hard_stopped") {
  if (state === "warning") return "Warning";
  if (state === "paused" || state === "hard_stopped") return "Paused";
  return "Normal";
}

function budgetStateClasses(state: "ok" | "warning" | "paused" | "hard_stopped") {
  if (state === "warning") return "bg-amber-100 text-amber-900";
  if (state === "paused" || state === "hard_stopped") return "bg-red-100 text-red-800";
  return "bg-emerald-100 text-emerald-800";
}

function UsageStat({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="rounded-md border bg-white/60 p-3 dark:bg-zinc-950/40">
      <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">{value}</dd>
    </div>
  );
}

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const rows = await sql<TaskRow[]>`
    SELECT t.id, t.hive_id, t.assigned_to, t.created_by, t.status, t.priority, t.title, t.brief,
           t.goal_id, t.sprint_number, t.qa_required, t.acceptance_criteria,
           t.result_summary, t.retry_count, t.doctor_attempts, t.failure_reason,
           t.usage_details, t.tokens_input, t.tokens_output, t.cost_cents, t.model_used,
           g.budget_cents AS goal_budget_cents,
           g.spent_cents AS goal_spent_cents,
           g.budget_state AS goal_budget_state,
           g.budget_warning_triggered_at AS goal_budget_warning_triggered_at,
           g.budget_enforced_at AS goal_budget_enforced_at,
           g.budget_enforcement_reason AS goal_budget_enforcement_reason,
           t.started_at, t.completed_at, t.created_at, t.updated_at
    FROM tasks t
    LEFT JOIN goals g ON g.id = t.goal_id
    WHERE t.id = ${id}
  `;

  if (rows.length === 0) {
    notFound();
  }

  const task = rows[0];

  const costDisplay =
    task.cost_cents !== null ? `$${(task.cost_cents / 100).toFixed(4)}` : null;

  const usage = toPublicUsageSummary({
    usageDetails: task.usage_details,
    tokensInput: task.tokens_input,
    tokensOutput: task.tokens_output,
    costCents: task.cost_cents,
  });

  const tokenDisplay =
    usage.promptTokens !== null && usage.outputTokens !== null
      ? `${usage.promptTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out`
      : null;

  const goalBudget = task.goal_budget_cents !== null || task.goal_spent_cents !== null
    ? serializeGoalBudgetStatus({
      budgetCents: task.goal_budget_cents,
      spentCents: task.goal_spent_cents,
      budgetState: task.goal_budget_state,
      warningTriggeredAt: task.goal_budget_warning_triggered_at,
      enforcedAt: task.goal_budget_enforced_at,
      reason: task.goal_budget_enforcement_reason,
      updatedAt: task.updated_at,
    })
    : null;

  const codexEmptyOutputDiagnostic = await readLatestCodexEmptyOutputDiagnostic(sql, id);
  const provenance = await readLatestTaskContextProvenance(sql, id);

  const workProducts = await sql<WorkProductRow[]>`
    SELECT id, content, summary, artifact_kind, mime_type, width, height,
           model_name, model_snapshot, prompt_tokens, output_tokens, cost_cents, created_at
    FROM work_products
    WHERE task_id = ${id}
    ORDER BY created_at ASC
  `;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Link
            href="/tasks"
            className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            &larr; Tasks
          </Link>
          <h1 className="text-2xl font-semibold">{task.title}</h1>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium capitalize ${
            STATUS_BADGE[task.status] ?? "bg-zinc-100 text-zinc-800"
          }`}
        >
          {task.status}
        </span>
      </div>

      {/* Brief */}
      <div className="rounded-lg border p-4 space-y-2">
        <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">Brief</h2>
        <p className="text-sm whitespace-pre-wrap">{task.brief}</p>
      </div>

      {/* Pipeline routing */}
      <TaskPipelineRouter hiveId={task.hive_id} taskId={task.id} taskTitle={task.title} />

      {/* Attachments */}
      <AttachmentsPanel scope="task" id={task.id} />

      {/* Live agent output */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">Agent Output</h2>
        <LiveActivityPanel
          taskId={task.id}
          taskTitle={task.title}
          taskStatus={task.status as "pending" | "active" | "completed" | "failed"}
        />
      </div>

      {(usage.promptTokens !== null || usage.outputTokens !== null || usage.costCents !== null || goalBudget) && (
        <div className="rounded-lg border p-4 space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">
                AI Usage
              </h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Canonical task-detail proof for recorded task usage and the persisted goal budget state.
              </p>
            </div>
            {goalBudget && (
              <span
                className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${budgetStateClasses(goalBudget.state)}`}
              >
                {budgetStateLabel(goalBudget.state)}
              </span>
            )}
          </div>

          {goalBudget && (
            <div className="space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  Goal budget status
                </h3>
                {goalBudget.percentUsed !== null && (
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                    {goalBudget.percentUsed}% used
                  </p>
                )}
              </div>
              <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <UsageStat label="Cap" value={formatUsd(goalBudget.capCents)} />
                <UsageStat label="Spend" value={formatUsd(goalBudget.spentCents)} />
                <UsageStat label="Remaining" value={formatUsd(goalBudget.remainingCents)} />
                <UsageStat
                  label="Status"
                  value={goalBudget.percentUsed !== null ? `${goalBudget.percentUsed}% used` : budgetStateLabel(goalBudget.state)}
                />
              </dl>
              {goalBudget.paused ? (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
                  <p className="font-medium">New AI work is paused because this goal reached its AI budget cap.</p>
                  {goalBudget.reason && <p className="mt-1">Pause reason: {goalBudget.reason}</p>}
                </div>
              ) : goalBudget.warning ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
                  Approaching the AI budget cap. New work can continue, but the next runs may trigger an automatic pause.
                </div>
              ) : (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
                  This task is within the current AI budget cap.
                </div>
              )}
            </div>
          )}

          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Recorded task usage</h3>
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <UsageStat
                label="Prompt tokens"
                value={usage.promptTokens !== null ? usage.promptTokens.toLocaleString() : null}
              />
              <UsageStat
                label="Output tokens"
                value={usage.outputTokens !== null ? usage.outputTokens.toLocaleString() : null}
              />
              <UsageStat
                label="Cache read"
                value={usage.cacheReadTokens !== null ? usage.cacheReadTokens.toLocaleString() : null}
              />
              <UsageStat
                label="Cache write"
                value={usage.cacheCreationTokens !== null ? usage.cacheCreationTokens.toLocaleString() : null}
              />
              <UsageStat label="Cost" value={formatUsd(usage.costCents)} />
            </dl>
          </div>
        </div>
      )}

      <div className="rounded-lg border p-4 space-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">
            Context Provenance
          </h2>
          <p className="text-xs text-zinc-500">{provenance.disclaimer}</p>
        </div>
        {provenance.entries.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {provenance.status === "none"
              ? "No retrieved memory/context sources were recorded for this task."
              : "Retrieved memory/context provenance is unavailable for this task."}
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {provenance.entries.map((entry) => (
              <li key={`${entry.sourceClass}:${entry.reference}`} className="grid gap-1 p-3 text-sm sm:grid-cols-3 sm:gap-4">
                <span className="font-medium capitalize text-zinc-700 dark:text-zinc-200">
                  {formatSourceClass(entry.sourceClass)}
                </span>
                <span className="break-all font-mono text-xs text-zinc-700 dark:text-zinc-200 sm:col-span-2">
                  {entry.reference}
                </span>
                {(entry.category || entry.sourceTaskId) && (
                  <span className="text-xs text-zinc-500 sm:col-span-3">
                    {entry.category ? `Category: ${entry.category}` : ""}
                    {entry.category && entry.sourceTaskId ? " · " : ""}
                    {entry.sourceTaskId ? `Source task: ${entry.sourceTaskId}` : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {workProducts.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">Work Products</h2>
          <div className="grid gap-4 md:grid-cols-2">
            {workProducts.map((wp) => {
              const isImage = wp.artifact_kind === "image" && wp.mime_type?.startsWith("image/");
              const href = `/api/work-products/${wp.id}/download`;
              return (
                <div key={wp.id} className="rounded-lg border p-4 space-y-3">
                  {isImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={href}
                      alt={wp.summary ?? "Generated work product image"}
                      className="aspect-video w-full rounded-md border object-contain"
                    />
                  ) : (
                    <p className="text-sm whitespace-pre-wrap">{wp.summary ?? wp.content}</p>
                  )}
                  <div className="space-y-1 text-xs text-zinc-500">
                    {wp.mime_type && <p>MIME: {wp.mime_type}</p>}
                    {wp.model_name && <p>Model: {wp.model_name}</p>}
                    {wp.model_snapshot && <p>Snapshot: {wp.model_snapshot}</p>}
                    {wp.width && wp.height && <p>Dimensions: {wp.width}x{wp.height}</p>}
                    {wp.prompt_tokens !== null && wp.output_tokens !== null && (
                      <p>
                        Tokens: {wp.prompt_tokens.toLocaleString()} in /{" "}
                        {wp.output_tokens.toLocaleString()} out
                      </p>
                    )}
                    {wp.cost_cents !== null && <p>Cost: ${(wp.cost_cents / 100).toFixed(4)}</p>}
                  </div>
                  {isImage && (
                    <Link href={href} className="text-sm text-blue-600 hover:underline dark:text-blue-400">
                      Open artifact
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Details */}
      <div className="rounded-lg border px-4">
        <dl>
          <DetailRow label="Assigned To" value={task.assigned_to} />
          <DetailRow label="Created By" value={task.created_by} />
          <DetailRow label="Priority" value={task.priority} />
          <DetailRow
            label="Goal"
            value={
              task.goal_id ? (
                <Link
                  href={`/goals/${task.goal_id}`}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  {task.goal_id}
                </Link>
              ) : null
            }
          />
          <DetailRow label="Sprint" value={task.sprint_number} />
          <DetailRow label="QA Required" value={task.qa_required ? "Yes" : "No"} />
          <DetailRow label="Model Used" value={task.model_used} />
          <DetailRow label="Tokens" value={tokenDisplay} />
          <DetailRow label="Cost" value={costDisplay} />
          <DetailRow
            label="Started"
            value={task.started_at ? new Date(task.started_at).toLocaleString() : null}
          />
          <DetailRow
            label="Completed"
            value={task.completed_at ? new Date(task.completed_at).toLocaleString() : null}
          />
          <DetailRow
            label="Created"
            value={new Date(task.created_at).toLocaleString()}
          />
          <DetailRow label="Retry Count" value={task.retry_count > 0 ? task.retry_count : null} />
          <DetailRow
            label="Doctor Attempts"
            value={task.doctor_attempts > 0 ? task.doctor_attempts : null}
          />
        </dl>
      </div>

      {/* Acceptance Criteria */}
      {task.acceptance_criteria && (
        <div className="rounded-lg border p-4 space-y-2">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">
            Acceptance Criteria
          </h2>
          <p className="text-sm whitespace-pre-wrap">{task.acceptance_criteria}</p>
        </div>
      )}

      {/* Result Summary */}
      {task.result_summary && (
        <div className="rounded-lg border p-4 space-y-2">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">
            Result Summary
          </h2>
          <p className="text-sm whitespace-pre-wrap">{task.result_summary}</p>
        </div>
      )}

      {/* Runtime Diagnostics */}
      {codexEmptyOutputDiagnostic && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 space-y-3 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-sm font-semibold text-zinc-600 uppercase tracking-wide dark:text-zinc-300">
            Runtime Diagnostics
          </h2>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-zinc-500">Codex empty output</dt>
              <dd className="font-mono text-zinc-900 dark:text-zinc-100">true</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Rollout signature present</dt>
              <dd className="font-mono text-zinc-900 dark:text-zinc-100">
                {String(codexEmptyOutputDiagnostic.rolloutSignaturePresent)}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Exit code</dt>
              <dd className="font-mono text-zinc-900 dark:text-zinc-100">
                {codexEmptyOutputDiagnostic.exitCode ?? "unknown"}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Effective adapter</dt>
              <dd className="font-mono text-zinc-900 dark:text-zinc-100">
                {codexEmptyOutputDiagnostic.effectiveAdapter || "unknown"}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Adapter override</dt>
              <dd className="font-mono text-zinc-900 dark:text-zinc-100">
                {codexEmptyOutputDiagnostic.adapterOverride || "none"}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Model</dt>
              <dd className="font-mono text-zinc-900 dark:text-zinc-100">
                {codexEmptyOutputDiagnostic.modelSlug || "unknown"}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Model/provider mismatch</dt>
              <dd className="font-mono text-zinc-900 dark:text-zinc-100">
                {String(codexEmptyOutputDiagnostic.modelProviderMismatchDetected)}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">CWD</dt>
              <dd className="break-all font-mono text-zinc-900 dark:text-zinc-100">
                {codexEmptyOutputDiagnostic.cwd || "unknown"}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">Truncated</dt>
              <dd className="font-mono text-zinc-900 dark:text-zinc-100">
                {String(codexEmptyOutputDiagnostic.truncated)}
              </dd>
            </div>
          </dl>
          {codexEmptyOutputDiagnostic.stderrTail && (
            <pre className="max-h-48 overflow-auto rounded border border-zinc-200 bg-white p-3 text-xs text-zinc-700 whitespace-pre-wrap dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200">
              {codexEmptyOutputDiagnostic.stderrTail}
            </pre>
          )}
        </div>
      )}

      {/* Failure Reason */}
      {task.failure_reason && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 space-y-2 dark:border-red-900 dark:bg-red-950">
          <h2 className="text-sm font-semibold text-red-700 uppercase tracking-wide dark:text-red-400">
            Failure Reason
          </h2>
          <p className="text-sm text-red-700 whitespace-pre-wrap dark:text-red-400">
            {task.failure_reason}
          </p>
        </div>
      )}
    </div>
  );
}
