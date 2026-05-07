"use client";

import Link from "next/link";
import cronstrue from "cronstrue";
import type { ScheduleDetail } from "@/schedules/detail";

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  active: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

function formatDate(value: Date | string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function formatDuration(startedAt: Date | string | null, completedAt: Date | string | null) {
  if (!startedAt || !completedAt) return "-";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function cronDescription(expression: string) {
  try {
    return cronstrue.toString(expression);
  } catch {
    return "Unable to interpret cron expression";
  }
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="grid grid-cols-3 gap-4 border-b py-3 last:border-b-0">
      <dt className="text-sm font-medium text-zinc-500">{label}</dt>
      <dd className="col-span-2 text-sm text-zinc-900 dark:text-zinc-100">{value}</dd>
    </div>
  );
}

export function ScheduleDetailView({ detail }: { detail: ScheduleDetail }) {
  const { schedule } = detail;
  const { role, runHistory, inProcessRuntime } = detail;
  const template = schedule.taskTemplate;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link
          href="/schedules"
          className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          &larr; Schedules
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">{template.title ?? "Untitled schedule"}</h1>
            <p className="mt-1 text-sm text-zinc-500">
              {schedule.enabled ? "Active" : "Paused"} schedule created by {schedule.createdBy}
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-sm font-medium ${
              schedule.enabled
                ? "bg-green-100 text-green-800"
                : "bg-zinc-100 text-zinc-600"
            }`}
          >
            {schedule.enabled ? "Active" : "Paused"}
          </span>
        </div>
      </div>

      <div className="rounded-lg border px-4">
        <dl>
          <DetailRow label="Cron" value={<code>{schedule.cronExpression}</code>} />
          <DetailRow label="Runs" value={cronDescription(schedule.cronExpression)} />
          <DetailRow label="Last Run" value={formatDate(schedule.lastRunAt)} />
          <DetailRow label="Next Run" value={formatDate(schedule.nextRunAt)} />
          <DetailRow label="Created At" value={formatDate(schedule.createdAt)} />
          <DetailRow label="Kind" value={template.kind ?? "task"} />
        </dl>
      </div>

      <div className="rounded-lg border p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Assigned Role</h2>
        {role ? (
          <div className="mt-4 space-y-4">
            <div>
              <p className="text-lg font-medium">{role.name}</p>
              <p className="text-sm text-zinc-500">
                {role.slug}
                {role.department ? ` - ${role.department}` : ""}
              </p>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Resolved Model
                </dt>
                <dd className="mt-1 font-mono text-sm">{role.recommendedModel ?? "-"}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Adapter
                </dt>
                <dd className="mt-1 font-mono text-sm">{role.adapterType}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2">
              {role.skills.length > 0 ? (
                role.skills.map((skill) => (
                  <span
                    key={skill}
                    className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-900 dark:bg-amber-400/15 dark:text-amber-200"
                  >
                    {skill}
                  </span>
                ))
              ) : (
                <span className="text-sm text-zinc-500">No skills assigned</span>
              )}
            </div>
          </div>
        ) : (
          <p className="mt-3 text-sm text-zinc-500">No active role found for {template.assignedTo ?? "this schedule"}.</p>
        )}
      </div>

      <div className="rounded-lg border p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Brief</h2>
        <pre className="mt-3 whitespace-pre-wrap rounded-md bg-zinc-50 p-4 font-mono text-sm leading-6 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
          {template.brief ?? "No brief recorded."}
        </pre>
      </div>

      <div className="rounded-lg border p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Recent Runs</h2>
        {inProcessRuntime ? (
          <p className="mt-3 text-sm text-zinc-500">
            This schedule runs in-process and does not create individual tasks.
          </p>
        ) : runHistory.length > 0 ? (
          <div className="mt-4 overflow-hidden rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="px-4 py-2 text-left">Created</th>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-left">Duration</th>
                  <th className="px-4 py-2 text-left">Task</th>
                </tr>
              </thead>
              <tbody>
                {runHistory.map((run) => (
                  <tr key={run.id} className="border-t">
                    <td className="px-4 py-2 text-xs text-zinc-500">{formatDate(run.createdAt)}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
                          STATUS_BADGE[run.status] ?? "bg-zinc-100 text-zinc-700"
                        }`}
                      >
                        {run.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-zinc-500">
                      {formatDuration(run.startedAt, run.completedAt)}
                    </td>
                    <td className="px-4 py-2">
                      <Link
                        href={`/tasks/${run.id}`}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        View task
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-sm text-zinc-500">No scheduler-created task runs found.</p>
        )}
      </div>

    </div>
  );
}
