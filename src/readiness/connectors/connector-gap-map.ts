import type { ConnectorDefinition, ConnectorEffectType, ConnectorRiskTier } from "@/connectors/registry";

export type NeededCapability = ConnectorEffectType | "draft" | "send";
export type ControlledAutonomyPhase = "shadow" | "internal_action" | "approval_external" | "narrow_autonomous" | "blocked";

export interface ControlledAutonomyToolRequirement {
  toolName: string;
  neededCapability: NeededCapability;
  category?: string;
}

export interface ConnectorGapMapRow {
  toolName: string;
  neededCapability: NeededCapability;
  existingConnector: "yes" | "partial" | "no";
  connectorSlug: string | null;
  authMethod: string | null;
  riskTier: string;
  controlledAutonomyPhaseAllowed: ControlledAutonomyPhase;
  missingWork: string;
}

const RISK_RANK: Record<ConnectorRiskTier, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function connectorMatchScore(connector: ConnectorDefinition, toolName: string): number {
  const normalizedTool = normalize(toolName);
  const slug = normalize(connector.slug);
  const name = normalize(connector.name);
  const haystack = normalize(`${connector.slug} ${connector.name} ${connector.category} ${connector.description}`);
  if (slug === normalizedTool || name === normalizedTool) return 100;
  if (slug.includes(normalizedTool) || name.includes(normalizedTool)) return 80;
  const parts = normalizedTool.split(" ").filter((part) => part.length >= 3);
  return parts.some((part) => haystack.includes(part)) ? 10 : 0;
}

function operationSupportsCapability(effectType: ConnectorEffectType, capability: NeededCapability): boolean {
  if (capability === "draft") return effectType === "system" || effectType === "write";
  if (capability === "send") return effectType === "notify" || effectType === "write";
  // Real-business controlled-autonomy deployments often need read-only finance visibility. Connector manifests
  // currently model Stripe charge listing as financial because data sensitivity is high,
  // not because the operation mutates money. Treat it as read-capable for gap mapping,
  // while policy preset still requires owner approval for financial reads.
  if (capability === "read" && effectType === "financial") return true;
  return effectType === capability;
}

function phaseForCapability(capability: NeededCapability, maxRisk: ConnectorRiskTier | null): ControlledAutonomyPhase {
  if (capability === "read") return maxRisk === "high" || maxRisk === "critical" ? "approval_external" : "shadow";
  if (capability === "system" || capability === "draft") return "internal_action";
  if (capability === "notify" || capability === "write" || capability === "send") return "approval_external";
  return "blocked";
}

function highestRisk(operations: ConnectorDefinition["operations"]): ConnectorRiskTier | null {
  return operations.reduce<ConnectorRiskTier | null>((current, operation) => {
    const risk = operation.governance.riskTier;
    if (!current || RISK_RANK[risk] > RISK_RANK[current]) return risk;
    return current;
  }, null);
}

export function buildConnectorGapMap(input: {
  requirements: ControlledAutonomyToolRequirement[];
  connectors: ConnectorDefinition[];
}): ConnectorGapMapRow[] {
  return input.requirements.map((requirement) => {
    const scoredConnectors = input.connectors
      .map((candidate) => ({ candidate, score: connectorMatchScore(candidate, requirement.toolName) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => {
        const capabilityDelta = Number(b.candidate.operations.some((operation) => operationSupportsCapability(operation.governance.effectType, requirement.neededCapability)))
          - Number(a.candidate.operations.some((operation) => operationSupportsCapability(operation.governance.effectType, requirement.neededCapability)));
        return capabilityDelta || b.score - a.score;
      });
    const connector = scoredConnectors[0]?.candidate;
    if (!connector) {
      return {
        toolName: requirement.toolName,
        neededCapability: requirement.neededCapability,
        existingConnector: "no",
        connectorSlug: null,
        authMethod: null,
        riskTier: "unknown",
        controlledAutonomyPhaseAllowed: "blocked",
        missingWork: "Build or install a scoped read-only connector before including this tool in the controlled-autonomy.",
      };
    }
    const matchingOps = connector.operations.filter((operation) => operationSupportsCapability(operation.governance.effectType, requirement.neededCapability));
    const hasCapability = matchingOps.length > 0;
    const maxRisk = highestRisk(matchingOps);
    return {
      toolName: requirement.toolName,
      neededCapability: requirement.neededCapability,
      existingConnector: hasCapability ? "yes" : "partial",
      connectorSlug: connector.slug,
      authMethod: connector.authType,
      riskTier: maxRisk ?? "medium",
      controlledAutonomyPhaseAllowed: hasCapability ? phaseForCapability(requirement.neededCapability, maxRisk) : "blocked",
      missingWork: hasCapability
        ? maxRisk === "high" || maxRisk === "critical"
          ? "Connector exists, but this capability is high-risk/sensitive and must stay owner-approved during the controlled-autonomy."
          : "None for the requested capability; still install credentials and run health smoke before controlled-autonomy use."
        : "Connector exists but does not expose the requested governed operation yet.",
    };
  });
}

export function renderConnectorGapMapMarkdown(rows: ConnectorGapMapRow[]): string {
  return [
    "# Connector Gap Map",
    "",
    ...rows.flatMap((row) => [
      `## ${row.toolName}`,
      `- Needed capability: ${row.neededCapability}`,
      `- Existing connector: ${row.existingConnector}`,
      `- Connector slug: ${row.connectorSlug ?? "none"}`,
      `- Auth method: ${row.authMethod ?? "unknown"}`,
      `- Risk tier: ${row.riskTier}`,
      `- ControlledAutonomy phase allowed: ${row.controlledAutonomyPhaseAllowed}`,
      `- Missing work: ${row.missingWork}`,
      "",
    ]),
  ].join("\n");
}
