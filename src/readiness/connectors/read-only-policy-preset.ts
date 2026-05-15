import type { ActionPolicyLike, ActionPolicyDecision } from "@/actions/policy";
import type { ConnectorDefinition, ConnectorEffectType } from "@/connectors/registry";

export function decisionForShadowControlledAutonomyEffect(effectType: ConnectorEffectType): ActionPolicyDecision {
  if (effectType === "read" || effectType === "system") return "allow";
  if (effectType === "financial") return "require_approval";
  if (effectType === "destructive") return "block";
  return "require_approval";
}

export function buildReadOnlyFirstPolicyPreset(input: {
  hiveId: string;
  connectors: ConnectorDefinition[];
}): ActionPolicyLike[] {
  return input.connectors.flatMap((connector, connectorIndex) => connector.operations.map((operation, operationIndex) => {
    const decision = decisionForShadowControlledAutonomyEffect(operation.governance.effectType);
    const conditions = decision === "allow"
      ? { riskTierAtMost: "medium" as const }
      : {};
    return {
      id: `readonly-controlled-autonomy:${connector.slug}:${operation.slug}`,
      hiveId: input.hiveId,
      connector: connector.slug,
      operation: operation.slug,
      effectType: operation.governance.effectType,
      effect: decision,
      priority: 1_000 - connectorIndex * 10 - operationIndex,
      disabled: false,
      conditions,
    } satisfies ActionPolicyLike;
  }));
}
