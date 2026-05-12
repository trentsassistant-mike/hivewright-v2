import { describe, expect, it } from "vitest";
import { CONNECTOR_REGISTRY } from "@/connectors/registry";
import { validateConnectorManifest } from "@/connectors/manifest-validation";

describe("connector registry governance metadata", () => {
  it("declares schemas, scopes, output summaries, risk tiers, and test paths for every operation", () => {
    for (const connector of CONNECTOR_REGISTRY) {
      expect(connector.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(connector.scopes.length, `${connector.slug} scopes`).toBeGreaterThan(0);
      for (const scope of connector.scopes) {
        expect(scope.key).toMatch(/^[a-z0-9_.:-]+$/);
        expect(scope.label).toEqual(expect.any(String));
        expect(["read", "write", "send", "admin", "financial", "pii"]).toContain(scope.kind);
      }
      for (const operation of connector.operations) {
        expect(operation.inputSchema.type, `${connector.slug}.${operation.slug} inputSchema`).toBe("object");
        expect(operation.inputSchema.properties).toEqual(expect.any(Object));
        expect(operation.outputSummary, `${connector.slug}.${operation.slug} outputSummary`).toEqual(expect.any(String));
        expect(operation.outputSummary.length).toBeGreaterThan(8);
        expect(["low", "medium", "high", "critical"]).toContain(operation.governance.riskTier);
        expect(["allow", "require_approval", "block"]).toContain(operation.governance.defaultDecision);
        expect(operation.governance.dryRunSupported, `${connector.slug}.${operation.slug} dryRunSupported`).toEqual(expect.any(Boolean));
        expect(operation.governance.externalSideEffect, `${connector.slug}.${operation.slug} externalSideEffect`).toEqual(expect.any(Boolean));
      }
      expect(validateConnectorManifest(connector).valid, connector.slug).toBe(true);
      const hasSafeTestPath = Boolean(connector.testConnection) || connector.operations.some((op) =>
        ["test_connection", "self_test"].includes(op.slug) &&
        op.governance.effectType === "system" &&
        op.governance.defaultDecision === "allow" &&
        op.governance.riskTier === "low"
      );
      expect(hasSafeTestPath, `${connector.slug} must expose a safe test path`).toBe(true);
    }
  });
});
