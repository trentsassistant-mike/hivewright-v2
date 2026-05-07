import { sql } from "@/app/api/_lib/db";
import { getGoalPlan } from "@/goals/goal-documents";

export async function GoalPlanPanel({ goalId }: { goalId: string }) {
  const plan = await getGoalPlan(sql, goalId);

  if (!plan) {
    return (
      <div className="space-y-2 rounded-lg border border-dashed p-4">
        <h2 className="text-lg font-semibold">Plan</h2>
        <p className="text-sm text-zinc-500">
          No plan yet. The goal supervisor will produce one before the first
          execution sprint.
        </p>
      </div>
    );
  }

  const updatedAtIso =
    plan.updatedAt instanceof Date
      ? plan.updatedAt.toISOString()
      : String(plan.updatedAt);

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <h2 className="text-lg font-semibold">{plan.title}</h2>
          <p className="text-xs text-zinc-500">
            Revision {plan.revision} · updated{" "}
            {new Date(updatedAtIso).toLocaleString()}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-950 dark:text-blue-300">
          plan
        </span>
      </div>
      <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded bg-zinc-50 p-3 text-xs leading-5 dark:bg-zinc-900">
        {plan.body}
      </pre>
    </div>
  );
}
