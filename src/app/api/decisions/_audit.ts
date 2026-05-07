import type { Sql } from "postgres";
import type { AuthenticatedApiUser } from "../_lib/auth";
import {
  AGENT_AUDIT_EVENTS,
  recordAgentAuditEventBestEffort,
  type AgentAuditEventType,
} from "@/audit/agent-events";

type DecisionAuditOutcome = "success" | "error" | "blocked" | "skipped";

type DecisionAuditInput = {
  sql: Sql;
  request?: Request;
  user: AuthenticatedApiUser;
  eventType: AgentAuditEventType;
  decision: {
    id: string;
    hive_id?: string | null;
    hiveId?: string | null;
    goal_id?: string | null;
    goalId?: string | null;
    task_id?: string | null;
    taskId?: string | null;
    kind?: string | null;
    priority?: string | null;
    status?: string | null;
    options?: unknown;
  };
  outcome?: DecisionAuditOutcome;
  metadata?: Record<string, unknown>;
};

function actorForUser(user: AuthenticatedApiUser) {
  return {
    type: user.email === "service@hivewright.local" ? "service" as const : "owner" as const,
    id: user.id,
    label: user.email,
  };
}

function requestId(request?: Request): string | null {
  return request?.headers.get("x-request-id") ??
    request?.headers.get("x-correlation-id") ??
    null;
}

function optionCount(options: unknown): number | null {
  if (Array.isArray(options)) return options.length;
  if (!options || typeof options !== "object") return null;
  const maybeOptions = (options as Record<string, unknown>).options;
  return Array.isArray(maybeOptions) ? maybeOptions.length : null;
}

export function decisionEventForResponse(response: string): AgentAuditEventType {
  if (response === "approved") return AGENT_AUDIT_EVENTS.decisionApproved;
  if (response === "rejected" || response === "dismiss_quality_feedback") {
    return AGENT_AUDIT_EVENTS.decisionRejected;
  }
  if (response === "discussed") return AGENT_AUDIT_EVENTS.decisionUpdated;
  return AGENT_AUDIT_EVENTS.decisionResolved;
}

export async function recordDecisionAuditEvent(input: DecisionAuditInput): Promise<void> {
  const hiveId = input.decision.hive_id ?? input.decision.hiveId ?? null;
  const goalId = input.decision.goal_id ?? input.decision.goalId ?? null;
  const taskId = input.decision.task_id ?? input.decision.taskId ?? null;

  await recordAgentAuditEventBestEffort(input.sql, {
    eventType: input.eventType,
    actor: actorForUser(input.user),
    hiveId,
    goalId,
    taskId,
    targetType: "decision",
    targetId: input.decision.id,
    outcome: input.outcome ?? "success",
    requestId: requestId(input.request),
    metadata: {
      occurredAt: new Date().toISOString(),
      route: input.request ? new URL(input.request.url).pathname : null,
      decisionId: input.decision.id,
      kind: input.decision.kind ?? null,
      priority: input.decision.priority ?? null,
      status: input.decision.status ?? null,
      optionCount: optionCount(input.decision.options),
      ...input.metadata,
    },
  });
}
