import { notFound } from "next/navigation";
import Link from "next/link";
import { sql } from "@/app/api/_lib/db";
import { getDecisionActivity } from "@/decisions/activity";

export const dynamic = "force-dynamic";

type DecisionRow = {
  id: string;
  hive_id: string;
  goal_id: string | null;
  task_id: string | null;
  title: string;
  context: string;
  recommendation: string | null;
  options: unknown;
  priority: string;
  status: string;
  kind: string;
  owner_response: string | null;
  selected_option_key: string | null;
  selected_option_label: string | null;
  resolved_by: string | null;
  ea_attempts: number;
  ea_reasoning: string | null;
  ea_decided_at: Date | null;
  created_at: Date;
  resolved_at: Date | null;
};

const PRIORITY_BADGE: Record<string, string> = {
  urgent: "border-red-300/30 bg-red-500/15 text-red-900 dark:text-red-100",
  high: "border-amber-300/35 bg-amber-300/15 text-amber-900 dark:text-amber-100",
  normal:
    "border-zinc-300/60 bg-zinc-100 text-zinc-700 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-zinc-300",
  low:
    "border-zinc-300/60 bg-zinc-50 text-zinc-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-zinc-400",
};

const STATUS_BADGE: Record<string, string> = {
  pending: "border-amber-300/35 bg-amber-300/15 text-amber-900 dark:text-amber-100",
  ea_review: "border-sky-300/35 bg-sky-300/15 text-sky-900 dark:text-sky-100",
  resolved: "border-emerald-300/35 bg-emerald-300/15 text-emerald-900 dark:text-emerald-100",
  auto_approved:
    "border-emerald-300/35 bg-emerald-300/15 text-emerald-900 dark:text-emerald-100",
};

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="grid gap-1 border-b border-amber-200/55 py-3 last:border-b-0 dark:border-white/[0.07] sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm font-medium text-amber-900/60 dark:text-zinc-500">{label}</dt>
      <dd className="text-sm text-zinc-900 dark:text-zinc-100 sm:col-span-2">{value}</dd>
    </div>
  );
}

function Panel({
  title,
  children,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-lg border border-amber-200/70 bg-amber-50/70 shadow-sm shadow-amber-950/5 dark:border-white/[0.08] dark:bg-white/[0.035] dark:shadow-black/20 ${className}`}
    >
      <div className="border-b border-amber-200/55 px-4 py-3 dark:border-white/[0.07]">
        <h2 className="text-[0.68rem] font-semibold uppercase text-amber-900/55 dark:text-zinc-500">
          {title}
        </h2>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function prettyJson(value: unknown) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default async function DecisionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [decision] = await sql<DecisionRow[]>`
    SELECT id, hive_id, goal_id, task_id, title, context, recommendation,
           options, priority, status, kind, owner_response,
           selected_option_key, selected_option_label, resolved_by,
           ea_attempts, ea_reasoning, ea_decided_at, created_at, resolved_at
    FROM decisions
    WHERE id = ${id}
  `;

  if (!decision) notFound();

  const activity = await getDecisionActivity(sql, id);
  const options = prettyJson(decision.options);

  return (
    <div className="space-y-6">
      <div className="hive-honey-glow flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <Link
            href="/decisions"
            className="text-sm font-medium text-amber-800/80 hover:text-amber-950 dark:text-amber-200/75 dark:hover:text-amber-100"
          >
            &larr; Decisions
          </Link>
          <h1 className="text-2xl font-semibold">{decision.title}</h1>
          <p className="font-mono text-xs text-zinc-500">{decision.id}</p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <span
            className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium capitalize ${
              STATUS_BADGE[decision.status] ?? STATUS_BADGE.pending
            }`}
          >
            {decision.status.replace("_", " ")}
          </span>
          <span
            className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium capitalize ${
              PRIORITY_BADGE[decision.priority] ?? PRIORITY_BADGE.normal
            }`}
          >
            {decision.priority}
          </span>
        </div>
      </div>

      <Panel title="Context">
        <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">
          {decision.context}
        </p>
      </Panel>

      {decision.recommendation && (
        <Panel title="Recommendation">
          <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">
            {decision.recommendation}
          </p>
        </Panel>
      )}

      <Panel title="Activity">
        <div className="mt-4 space-y-4">
          {activity.length === 0 ? (
            <p className="text-sm text-zinc-500">No activity recorded yet.</p>
          ) : (
            activity.map((entry) => (
              <div
                key={entry.id}
                className="grid gap-1 rounded-r-md border-l-2 border-amber-300 bg-white/45 py-2 pl-3 pr-2 dark:bg-black/[0.12]"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold capitalize text-zinc-700 dark:text-zinc-200">
                    {entry.actor}
                  </span>
                  <span className="text-zinc-400">{entry.timestamp.toLocaleString()}</span>
                  <span className="font-mono text-[11px] text-zinc-400">
                    {entry.sourceType}:{entry.sourceId.slice(0, 8)}
                  </span>
                </div>
                <p className="text-sm text-zinc-700 dark:text-zinc-300">{entry.summary}</p>
              </div>
            ))
          )}
        </div>
      </Panel>

      <section className="rounded-lg border border-amber-200/70 bg-amber-50/70 px-4 shadow-sm shadow-amber-950/5 dark:border-white/[0.08] dark:bg-white/[0.035]">
        <dl>
          <DetailRow label="Hive" value={decision.hive_id} />
          <DetailRow
            label="Goal"
            value={
              decision.goal_id ? (
                <Link
                  href={`/goals/${decision.goal_id}`}
                  className="text-amber-800 hover:underline dark:text-amber-200"
                >
                  {decision.goal_id}
                </Link>
              ) : null
            }
          />
          <DetailRow
            label="Task"
            value={
              decision.task_id ? (
                <Link
                  href={`/tasks/${decision.task_id}`}
                  className="text-amber-800 hover:underline dark:text-amber-200"
                >
                  {decision.task_id}
                </Link>
              ) : null
            }
          />
          <DetailRow label="Kind" value={decision.kind} />
          <DetailRow label="Owner response" value={decision.owner_response} />
          <DetailRow label="Selected option" value={decision.selected_option_label ?? decision.selected_option_key} />
          <DetailRow label="EA attempts" value={decision.ea_attempts} />
          <DetailRow label="EA reasoning" value={decision.ea_reasoning} />
          <DetailRow
            label="EA decided"
            value={decision.ea_decided_at ? decision.ea_decided_at.toLocaleString() : null}
          />
          <DetailRow label="Resolved by" value={decision.resolved_by} />
          <DetailRow
            label="Resolved"
            value={decision.resolved_at ? decision.resolved_at.toLocaleString() : null}
          />
          <DetailRow label="Created" value={decision.created_at.toLocaleString()} />
        </dl>
      </section>

      {options && options !== "null" && (
        <Panel title="Options">
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-amber-200/60 bg-white/55 p-3 text-xs text-zinc-800 dark:border-white/[0.08] dark:bg-black/[0.18] dark:text-zinc-100">
            {options}
          </pre>
        </Panel>
      )}
    </div>
  );
}
