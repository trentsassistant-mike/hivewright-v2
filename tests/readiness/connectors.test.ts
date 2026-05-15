import { describe, expect, it } from "vitest";
import { evaluateActionPolicy } from "@/actions/policy";
import { CONNECTOR_REGISTRY } from "@/connectors/registry";
import { buildConnectorGapMap } from "@/readiness/connectors/connector-gap-map";
import { buildReadOnlyFirstPolicyPreset, decisionForShadowControlledAutonomyEffect } from "@/readiness/connectors/read-only-policy-preset";

describe("connector readiness", () => {
  it("maps target tools to connector status without pretending missing connectors exist", () => {
    const rows = buildConnectorGapMap({
      connectors: CONNECTOR_REGISTRY,
      requirements: [
        { toolName: "Gmail", neededCapability: "read" },
        { toolName: "Xero", neededCapability: "read" },
        { toolName: "Discord", neededCapability: "notify" },
        { toolName: "Stripe", neededCapability: "read" },
      ],
    });
    expect(rows.find((row) => row.toolName === "Gmail")?.existingConnector).toBe("yes");
    expect(rows.find((row) => row.toolName === "Discord")?.controlledAutonomyPhaseAllowed).toBe("approval_external");
    expect(rows.find((row) => row.toolName === "Xero")?.existingConnector).toBe("no");
    const stripe = rows.find((row) => row.toolName === "Stripe");
    expect(stripe?.existingConnector).toBe("yes");
    expect(stripe?.riskTier).toBe("high");
    expect(stripe?.controlledAutonomyPhaseAllowed).toBe("approval_external");
    expect(stripe?.missingWork).toContain("owner-approved");
  });

  it("defaults read/system to allow, sends/writes/financial to approval, and destructive to block", () => {
    expect(decisionForShadowControlledAutonomyEffect("read")).toBe("allow");
    expect(decisionForShadowControlledAutonomyEffect("system")).toBe("allow");
    expect(decisionForShadowControlledAutonomyEffect("notify")).toBe("require_approval");
    expect(decisionForShadowControlledAutonomyEffect("write")).toBe("require_approval");
    expect(decisionForShadowControlledAutonomyEffect("financial")).toBe("require_approval");
    expect(decisionForShadowControlledAutonomyEffect("destructive")).toBe("block");
  });

  it("produces policies that override risky connector defaults during shadow controlled-autonomy", () => {
    const hiveId = "00000000-0000-0000-0000-000000000001";
    const policies = buildReadOnlyFirstPolicyPreset({ hiveId, connectors: CONNECTOR_REGISTRY });
    const discordSend = evaluateActionPolicy({
      hiveId,
      connectorSlug: "discord-webhook",
      operation: "send_message",
      effectType: "notify",
      defaultDecision: "allow",
      riskTier: "low",
      policies,
    });
    expect(discordSend.decision).toBe("require_approval");

    const stripeRead = evaluateActionPolicy({
      hiveId,
      connectorSlug: "stripe",
      operation: "list_recent_charges",
      effectType: "financial",
      defaultDecision: "require_approval",
      riskTier: "low",
      policies,
    });
    expect(stripeRead.decision).toBe("require_approval");
  });
});
