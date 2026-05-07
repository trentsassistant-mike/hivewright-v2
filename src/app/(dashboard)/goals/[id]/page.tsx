import { notFound } from "next/navigation";
import Link from "next/link";
import { sql } from "@/app/api/_lib/db";
import { GoalLiveActivity } from "@/components/goal-live-activity";
import { GoalPlanPanel } from "@/components/goal-plan-panel";
import { AttachmentsPanel } from "@/components/attachments-panel";
import { GoalCommentsPanel } from "@/components/goal-comments-panel";
import { SupervisorActivityPanel } from "@/components/supervisor-activity-panel";

export const dynamic = "force-dynamic";

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  active: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  paused: "bg-zinc-100 text-zinc-800",
};

type GoalRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  budget_cents: number | null;
  spent_cents: number;
  parent_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type SubGoalRow = {
  id: string;
  title: string;
  status: string;
};

type TaskRow = {
  id: string;
  title: string;
  assigned_to: string;
  status: string;
  sprint_number: number | null;
  created_at: Date;
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
        STATUS_BADGE[status] ?? "bg-zinc-100 text-zinc-800"
      }`}
    >
      {status}
    </span>
  );
}

export default async function GoalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [goalRows, subGoalRows, taskRows] = await Promise.all([
    sql<GoalRow[]>`
      SELECT id, title, description, status, budget_cents, spent_cents, parent_id, created_at, updated_at
      FROM goals
      WHERE id = ${id}
    `,
    sql<SubGoalRow[]>`
      SELECT id, title, status
      FROM goals
      WHERE parent_id = ${id}
      ORDER BY created_at ASC
    `,
    sql<TaskRow[]>`
      SELECT id, title, assigned_to, status, sprint_number, created_at
      FROM tasks
      WHERE goal_id = ${id}
      ORDER BY sprint_number ASC NULLS LAST, created_at ASC
    `,
  ]);

  if (goalRows.length === 0) {
    notFound();
  }

  const goal = goalRows[0];

  // Group tasks by sprint
  const sprintMap = new Map<string, TaskRow[]>();
  for (const task of taskRows) {
    const key = task.sprint_number !== null ? `Sprint ${task.sprint_number}` : "No Sprint";
    const group = sprintMap.get(key) ?? [];
    group.push(task);
    sprintMap.set(key, group);
  }

  const budgetDisplay =
    goal.budget_cents !== null
      ? `$${(goal.spent_cents / 100).toFixed(2)} spent / $${(goal.budget_cents / 100).toFixed(2)} budget`
      : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Link
            href="/goals"
            className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            &larr; Goals
          </Link>
          <h1 className="text-2xl font-semibold">{goal.title}</h1>
          {budgetDisplay && (
            <p className="text-sm text-zinc-500">{budgetDisplay}</p>
          )}
        </div>
        <StatusBadge status={goal.status} />
      </div>

      {/* Description */}
      {goal.description && (
        <div className="rounded-lg border p-4 space-y-2">
          <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">
            Description
          </h2>
          <p className="text-sm whitespace-pre-wrap">{goal.description}</p>
        </div>
      )}

      {/* Attachments */}
      <AttachmentsPanel scope="goal" id={goal.id} />

      {/* Sub-goals */}
      {subGoalRows.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Sub-goals</h2>
          <div className="rounded-lg border divide-y">
            {subGoalRows.map((sub) => (
              <div key={sub.id} className="flex items-center justify-between px-4 py-3">
                <Link
                  href={`/goals/${sub.id}`}
                  className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  {sub.title}
                </Link>
                <StatusBadge status={sub.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Durable goal plan — produced by the supervisor before execution */}
      <GoalPlanPanel goalId={goal.id} />

      {/* Owner feedback thread — persist rework requests on the goal */}
      <GoalCommentsPanel goalId={goal.id} />

      {/* Supervisor's own thoughts + tool calls, parsed from the codex
          rollout file. Polls every 5 s while the goal is active. */}
      <SupervisorActivityPanel goalId={goal.id} />

      {/* Live agent activity — uses goal stream so tasks that start after page
          load appear automatically without a manual refresh */}
      <GoalLiveActivity
        goalId={goal.id}
        taskTitles={Object.fromEntries(taskRows.map((t) => [t.id, t.title]))}
      />

      {/* Tasks grouped by sprint */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Tasks</h2>
        {taskRows.length === 0 ? (
          <p className="text-sm text-zinc-500">No tasks yet.</p>
        ) : (
          Array.from(sprintMap.entries()).map(([sprintLabel, tasks]) => (
            <div key={sprintLabel} className="space-y-2">
              <h3 className="text-sm font-semibold text-zinc-500">{sprintLabel}</h3>
              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 dark:bg-zinc-900">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium text-zinc-500">Title</th>
                      <th className="px-4 py-2 text-left font-medium text-zinc-500">Role</th>
                      <th className="px-4 py-2 text-left font-medium text-zinc-500">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {tasks.map((task) => (
                      <tr key={task.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900">
                        <td className="px-4 py-2">
                          <Link
                            href={`/tasks/${task.id}`}
                            className="text-blue-600 hover:underline dark:text-blue-400"
                          >
                            {task.title}
                          </Link>
                        </td>
                        <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                          {task.assigned_to}
                        </td>
                        <td className="px-4 py-2">
                          <StatusBadge status={task.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
