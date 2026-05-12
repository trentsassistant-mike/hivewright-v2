"use client";
import type { AgentObservability } from "@/agents/observability";

function formatDateTime(value: string | null | undefined) {
  if (!value) return "not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not recorded";
  return date.toLocaleString();
}

export function AgentObservabilityPanel({
  data,
  loading,
  error,
  hiveName,
  onClose,
}: {
  data: AgentObservability | null;
  loading: boolean;
  error: string | null;
  hiveName: string | null;
  onClose: () => void;
}) {
  return (
    <section className="space-y-4 rounded-lg border border-zinc-200 bg-white/70 p-4 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.025]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Agent observability</h2>
          <p className="text-xs text-zinc-500">
            {hiveName ? `Scope: ${hiveName}` : "Scope: all visible hives"}
          </p>
        </div>
        <button
          onClick={onClose}
          className="rounded border border-zinc-300/60 px-2 py-1 text-xs text-zinc-500 hover:border-zinc-400 dark:border-zinc-700/60"
        >
          Close
        </button>
      </div>

      {loading && <p className="rounded-md border border-dashed p-4 text-sm text-zinc-500">Loading agent observability.</p>}
      {error && <p className="rounded-md border border-red-300/40 bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/20 dark:text-red-200">{error}</p>}

      {!loading && !error && data && (
        <div className="space-y-6">
          {/* ── Agent-level history ── */}
          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                Agent
              </span>
              <h3 className="text-sm font-medium">Run history</h3>
            </div>
            {data.history.emptyMessage ? (
              <EmptyLine>{data.history.emptyMessage}</EmptyLine>
            ) : (
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded border px-2 py-1 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
                  {data.history.agentLevel.totalRuns} recent run{data.history.agentLevel.totalRuns === 1 ? "" : "s"}
                </span>
                <span className="rounded border px-2 py-1 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
                  Last run: {formatDateTime(data.history.agentLevel.lastRunAt)}
                </span>
                {Object.entries(data.history.agentLevel.statusCounts).map(([status, count]) => (
                  <span key={status} className={`rounded border px-2 py-1 ${statusColor(status)}`}>
                    {status}: {count}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* ── Usage trend ── */}
          <MetadataCluster title="Usage trend">
            <MetadataLine label="Total recent runs" value={`${data.usageSummary.totalRuns}`} />
            <MetadataLine label="Completed runs" value={`${data.usageSummary.completedRuns}`} />
            <MetadataLine label="Failed or cancelled runs" value={`${data.usageSummary.failedRuns}`} />
            {data.usageSummary.recentDailyCounts.length === 0 ? (
              <EmptyLine>No usage trend is available for this agent yet.</EmptyLine>
            ) : (
              <div className="md:col-span-2">
                <UsageTrendChart dailyCounts={data.usageSummary.recentDailyCounts} />
              </div>
            )}
          </MetadataCluster>

          {/* ── Task-level history ── */}
          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wider text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                Task
              </span>
              <h3 className="text-sm font-medium">Execution history</h3>
            </div>
            {data.history.taskLevel.length === 0 ? (
              <EmptyLine>No task-level run records are available for this agent.</EmptyLine>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-xs">
                  <thead className="text-zinc-500">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Task</th>
                      <th className="py-2 pr-3 font-medium">Status</th>
                      <th className="py-2 pr-3 font-medium">Model</th>
                      <th className="py-2 pr-3 font-medium">Created by</th>
                      <th className="py-2 pr-3 font-medium">Started</th>
                      <th className="py-2 pr-3 font-medium">Completed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200/70 dark:divide-white/[0.06]">
                    {data.history.taskLevel.map((task) => (
                      <tr key={task.id}>
                        <td className="max-w-[18rem] py-2 pr-3">
                          <a href={`/tasks/${task.id}`} className="truncate text-blue-700 hover:underline dark:text-blue-300">
                            {task.title}
                          </a>
                          <div className="font-mono text-[0.68rem] text-zinc-400">{task.id}</div>
                        </td>
                        <td className="py-2 pr-3">
                          <span className={statusColor(task.status)}>{task.status}</span>
                        </td>
                        <td className="py-2 pr-3 font-mono text-zinc-500">
                          {task.modelUsed ? shortModel(task.modelUsed) : "—"}
                        </td>
                        <td className="py-2 pr-3 text-zinc-500">{task.createdBy}</td>
                        <td className="py-2 pr-3">{formatDateTime(task.startedAt)}</td>
                        <td className="py-2 pr-3">{formatDateTime(task.completedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Schedule state ── */}
          <MetadataCluster title="Schedule state">
            {data.scheduleState.schedules.length === 0 ? (
              <EmptyLine>{data.scheduleState.message}</EmptyLine>
            ) : (
              data.scheduleState.schedules.map((schedule) => (
                <MetadataLine
                  key={schedule.id}
                  label={schedule.title ?? schedule.kind ?? schedule.id}
                  value={`${schedule.enabled ? "enabled" : "disabled"} · last ${formatDateTime(schedule.lastRunAt)} · next ${formatDateTime(schedule.nextRunAt)}`}
                />
              ))
            )}
          </MetadataCluster>

          {/* ── Tools and apps ── */}
          <MetadataCluster title="Tools and apps">
            {data.tools.length === 0 ? (
              <EmptyLine>{data.toolsEmptyMessage}</EmptyLine>
            ) : (
              data.tools.map((tool) => (
                <MetadataLine key={`${tool.source}:${tool.slug}`} label={tool.label} value={tool.source === "runtime-default" ? "runtime default" : tool.slug} />
              ))
            )}
            {data.connectedApps.length === 0 ? (
              <EmptyLine>{data.connectedAppsEmptyMessage}</EmptyLine>
            ) : (
              data.connectedApps.map((app) => (
                <MetadataLine key={app.id} label={app.displayName} value={`${app.connectorSlug} · ${app.status}`} />
              ))
            )}
          </MetadataCluster>

          {/* ── Memory metadata ── */}
          <MetadataCluster title="Memory metadata">
            {data.memory.roleMemory.length === 0 && data.memory.hiveMemory.length === 0 ? (
              <EmptyLine>{data.memory.emptyMessage}</EmptyLine>
            ) : (
              <>
                {data.memory.roleMemory.map((memory) => (
                  <MetadataLine key={memory.id} label={`role memory ${memory.id}`} value={`${memory.sensitivity} · confidence ${memory.confidence}`} />
                ))}
                {data.memory.hiveMemory.map((memory) => (
                  <MetadataLine key={memory.id} label={`hive memory ${memory.id}`} value={`${memory.category} · ${memory.sensitivity}`} />
                ))}
              </>
            )}
          </MetadataCluster>

          {/* ── Files and artifacts ── */}
          <MetadataCluster title="Files and artifacts">
            {data.files.attachments.length === 0 && data.files.workProducts.length === 0 ? (
              <EmptyLine>{data.files.emptyMessage}</EmptyLine>
            ) : (
              <>
                {data.files.attachments.map((file) => (
                  <MetadataLine key={file.id} label={file.filename} value={`${file.mimeType ?? "unknown type"} · ${file.sizeBytes} bytes`} />
                ))}
                {data.files.workProducts.map((artifact) => (
                  <MetadataLine key={artifact.id} label={artifact.fileLabel} value={`${artifact.artifactKind ?? "artifact"} · ${artifact.sensitivity}`} />
                ))}
              </>
            )}
          </MetadataCluster>
        </div>
      )}
    </section>
  );
}

function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return "text-emerald-600 dark:text-emerald-400";
    case "failed":
    case "cancelled":
      return "text-red-600 dark:text-red-400";
    case "blocked":
      return "text-amber-600 dark:text-amber-400";
    case "running":
    case "in_progress":
      return "text-blue-600 dark:text-blue-400";
    default:
      return "text-zinc-600 dark:text-zinc-300";
  }
}

function shortModel(id: string): string {
  return id.includes("/") ? id.split("/")[1]! : id;
}

function UsageTrendChart({ dailyCounts }: { dailyCounts: { date: string; count: number }[] }) {
  const maxCount = Math.max(...dailyCounts.map((d) => d.count), 1);
  return (
    <div className="flex items-end gap-1" role="img" aria-label="Daily usage trend">
      {dailyCounts.map((day) => (
        <div key={day.date} className="flex flex-col items-center gap-1" title={`${day.date}: ${day.count} run${day.count === 1 ? "" : "s"}`}>
          <div
            className="w-6 rounded-t bg-blue-500/70 dark:bg-blue-400/50"
            style={{ height: `${Math.max((day.count / maxCount) * 48, 4)}px` }}
          />
          <span className="text-[0.6rem] text-zinc-400">{day.date.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

function MetadataCluster({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-medium">{title}</h3>
      <div className="mt-2 grid gap-2 md:grid-cols-2">{children}</div>
    </div>
  );
}

function MetadataLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-zinc-200/70 px-3 py-2 text-xs dark:border-white/[0.07]">
      <div className="truncate font-medium text-zinc-700 dark:text-zinc-200">{label}</div>
      <div className="truncate text-zinc-500">{value}</div>
    </div>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-dashed border-zinc-300/60 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-700/60">
      {children}
    </p>
  );
}
