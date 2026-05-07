import type { Sql } from "postgres";
import { loadModelRoutingView } from "@/model-routing/registry";
import {
  resolveConfiguredModelRoute,
  type ModelRoutingPolicy,
  type ResolvedModelRoute,
} from "@/model-routing/selector";

export type SupervisorBackend = "codex" | "openclaw";

export interface GoalSupervisorRuntime {
  backend: SupervisorBackend;
  adapterType: SupervisorBackend;
  model: string;
  route: ResolvedModelRoute;
}

interface GoalSupervisorRoutingContext {
  title?: string | null;
  description?: string | null;
  status?: string | null;
}

const SUPERVISOR_BACKENDS = new Set<SupervisorBackend>(["codex", "openclaw"]);

export function resolveGoalSupervisorRouteFromConfig(input: {
  adapterType: string | null;
  recommendedModel: string | null;
  policy: ModelRoutingPolicy | null;
  goalContext?: GoalSupervisorRoutingContext | null;
}): GoalSupervisorRuntime | null {
  const policy = input.policy
    ? {
        ...input.policy,
        candidates: input.policy.candidates.filter((candidate) =>
          SUPERVISOR_BACKENDS.has(candidate.adapterType as SupervisorBackend),
        ),
      }
    : null;

  const route = resolveConfiguredModelRoute({
    roleSlug: "goal-supervisor",
    roleType: "system",
    manualAdapterType: input.adapterType,
    manualModel: input.recommendedModel,
    policy,
    taskContext: goalSupervisorTaskContext(input.goalContext),
  });

  if (!route.adapterType || !route.model) return null;
  if (!SUPERVISOR_BACKENDS.has(route.adapterType as SupervisorBackend)) return null;

  const backend = route.adapterType as SupervisorBackend;
  return {
    backend,
    adapterType: backend,
    model: route.model,
    route,
  };
}

export async function resolveGoalSupervisorRuntime(
  sql: Sql,
  goalId: string,
): Promise<GoalSupervisorRuntime> {
  const [goal] = await sql<{
    hive_id: string;
    title: string | null;
    description: string | null;
    status: string | null;
  }[]>`
    SELECT hive_id, title, description, status
    FROM goals
    WHERE id = ${goalId}
  `;
  if (!goal?.hive_id) {
    throw new Error(`Goal ${goalId} not found`);
  }

  const [role] = await sql<{
    adapter_type: string | null;
    recommended_model: string | null;
  }[]>`
    SELECT adapter_type, recommended_model
    FROM role_templates
    WHERE slug = 'goal-supervisor'
  `;

  const { policy } = await loadModelRoutingView(sql, goal.hive_id);
  const runtime = resolveGoalSupervisorRouteFromConfig({
    adapterType: role?.adapter_type ?? null,
    recommendedModel: role?.recommended_model ?? null,
    policy,
    goalContext: {
      title: goal.title,
      description: goal.description,
      status: goal.status,
    },
  });

  if (!runtime) {
    throw new Error(
      "goal-supervisor auto routing has no enabled codex/openclaw persistent-session candidate; configure model routing or pin the role in the dashboard",
    );
  }

  return runtime;
}

export function codexCliModelName(model: string): string {
  return model.includes("/") ? model.split("/").at(-1) ?? model : model;
}

function goalSupervisorTaskContext(goal: GoalSupervisorRoutingContext | null | undefined): {
  taskTitle: string;
  taskBrief: string;
  acceptanceCriteria: string;
  retryCount: number;
} {
  const title = goal?.title?.trim() || "Goal supervisor planning";
  const description = goal?.description?.trim();
  const status = goal?.status?.trim();
  const contextLines = [
    description,
    status ? `Current goal status: ${status}` : null,
  ].filter((line): line is string => Boolean(line));

  return {
    taskTitle: title,
    taskBrief: contextLines.length > 0
      ? contextLines.join("\n")
      : "Analyze goal state, decide next steps, and supervise work.",
    acceptanceCriteria: "A safe next action is selected.",
    retryCount: 0,
  };
}
