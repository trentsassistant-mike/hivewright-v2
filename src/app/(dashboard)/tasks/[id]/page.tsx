import { notFound } from "next/navigation";
import Link from "next/link";
import { sql } from "@/app/api/_lib/db";
import { LiveActivityPanel } from "@/components/live-activity-panel";
import { AttachmentsPanel } from "@/components/attachments-panel";
import { readLatestCodexEmptyOutputDiagnostic } from "@/runtime-diagnostics/codex-empty-output";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  active: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
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
  tokens_input: number | null;
  tokens_output: number | null;
  cost_cents: number | null;
  model_used: string | null;
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

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const rows = await sql<TaskRow[]>`
    SELECT id, hive_id, assigned_to, created_by, status, priority, title, brief,
           goal_id, sprint_number, qa_required, acceptance_criteria,
           result_summary, retry_count, doctor_attempts, failure_reason,
           tokens_input, tokens_output, cost_cents, model_used,
           started_at, completed_at, created_at, updated_at
    FROM tasks
    WHERE id = ${id}
  `;

  if (rows.length === 0) {
    notFound();
  }

  const task = rows[0];

  const costDisplay =
    task.cost_cents !== null ? `$${(task.cost_cents / 100).toFixed(4)}` : null;

  const tokenDisplay =
    task.tokens_input !== null && task.tokens_output !== null
      ? `${task.tokens_input.toLocaleString()} in / ${task.tokens_output.toLocaleString()} out`
      : null;

  const codexEmptyOutputDiagnostic = await readLatestCodexEmptyOutputDiagnostic(sql, id);

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
