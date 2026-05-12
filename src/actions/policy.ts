import type { Sql, TransactionSql } from "postgres";

export type ActionPolicyDecision = "allow" | "require_approval" | "block";

export interface ActionPolicyLike {
  id: string;
  hiveId: string;
  connectorSlug?: string | null;
  connector?: string | null;
  operation?: string | null;
  effectType?: string | null;
  roleSlug?: string | null;
  decision?: ActionPolicyDecision;
  effect?: ActionPolicyDecision;
  priority?: number | null;
  disabled?: boolean | null;
}

export interface EvaluateActionPolicyInput {
  hiveId: string;
  connectorSlug: string;
  operation: string;
  effectType: string;
  defaultDecision: ActionPolicyDecision;
  actorRoleSlug?: string | null;
  args?: unknown;
  policies?: ActionPolicyLike[];
}

export interface ActionPolicyEvaluationResult {
  decision: ActionPolicyDecision;
  reason: string;
  policyId?: string;
}

export type ActionPolicySql = Sql | TransactionSql;

interface ActionPolicyRow {
  id: string;
  hive_id: string;
  connector: string | null;
  operation: string | null;
  effect_type: string | null;
  effect: ActionPolicyDecision;
  role_slug: string | null;
  priority: number | null;
  enabled: boolean | null;
}

const DECISION_TIE_BREAK_RANK: Record<ActionPolicyDecision, number> = {
  allow: 0,
  require_approval: 1,
  block: 2,
};

function matchesNullableField(policyValue: string | null | undefined, inputValue: string): boolean {
  return policyValue == null || policyValue === inputValue;
}

function getPolicyConnectorSlug(policy: ActionPolicyLike): string | null | undefined {
  return policy.connectorSlug ?? policy.connector;
}

function getPolicyDecision(policy: ActionPolicyLike): ActionPolicyDecision {
  return policy.decision ?? policy.effect ?? "require_approval";
}

function matchesPolicy(policy: ActionPolicyLike, input: EvaluateActionPolicyInput): boolean {
  if (policy.disabled) {
    return false;
  }

  if (policy.hiveId !== input.hiveId) {
    return false;
  }

  if (!matchesNullableField(getPolicyConnectorSlug(policy), input.connectorSlug)) {
    return false;
  }

  if (!matchesNullableField(policy.operation, input.operation)) {
    return false;
  }

  if (!matchesNullableField(policy.effectType, input.effectType)) {
    return false;
  }

  if (policy.roleSlug != null && policy.roleSlug !== input.actorRoleSlug) {
    return false;
  }

  return true;
}

function comparePolicies(a: ActionPolicyLike, b: ActionPolicyLike): number {
  const priorityDelta = (b.priority ?? 0) - (a.priority ?? 0);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return DECISION_TIE_BREAK_RANK[getPolicyDecision(b)] - DECISION_TIE_BREAK_RANK[getPolicyDecision(a)];
}

export function evaluateActionPolicy(
  input: EvaluateActionPolicyInput,
): ActionPolicyEvaluationResult {
  const matchingPolicy = [...(input.policies ?? [])]
    .filter((policy) => matchesPolicy(policy, input))
    .sort(comparePolicies)[0];

  if (!matchingPolicy) {
    return {
      decision: input.defaultDecision,
      reason: `connector operation default decision: ${input.defaultDecision}`,
    };
  }

  return {
    decision: getPolicyDecision(matchingPolicy),
    reason: `matched action policy ${matchingPolicy.id}`,
    policyId: matchingPolicy.id,
  };
}

export async function loadActionPoliciesForHive(
  sql: ActionPolicySql,
  hiveId: string,
): Promise<ActionPolicyLike[]> {
  const rows = (await sql`
    SELECT id, hive_id, connector, operation, effect_type, effect, role_slug, priority, enabled
    FROM action_policies
    WHERE hive_id = ${hiveId}::uuid
  `) as unknown as ActionPolicyRow[];

  return rows.map((row) => ({
    id: row.id,
    hiveId: row.hive_id,
    connector: row.connector,
    operation: row.operation,
    effectType: row.effect_type,
    roleSlug: row.role_slug,
    effect: row.effect,
    priority: row.priority ?? 0,
    disabled: row.enabled === false,
  }));
}
