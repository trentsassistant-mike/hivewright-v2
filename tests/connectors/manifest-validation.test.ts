import { describe, expect, it } from "vitest";
import { validateConnectorManifest } from "@/connectors/manifest-validation";
import type { ConnectorDefinition } from "@/connectors/registry";

function manifest(overrides: Partial<ConnectorDefinition> = {}): ConnectorDefinition {
  return {
    slug: "sample-connector",
    name: "Sample",
    category: "ops",
    description: "Sample connector",
    authType: "api_key",
    setupFields: [{ key: "token", label: "Token", type: "password", required: true }],
    secretFields: ["token"],
    scopes: [{ key: "sample-connector:read", label: "Read", kind: "read", required: true }],
    operations: [{
      slug: "read",
      label: "Read",
      inputSchema: { type: "object", properties: {} },
      outputSummary: "Reads sample data.",
      governance: { effectType: "read", defaultDecision: "allow", riskTier: "low", scopes: ["sample-connector:read"] },
      handler: async () => ({}),
    }],
    ...overrides,
  };
}

describe("connector manifest validation", () => {
  it("accepts a complete governed manifest", () => {
    expect(validateConnectorManifest(manifest()).valid).toBe(true);
  });

  it("rejects missing and malformed connector metadata", () => {
    const result = validateConnectorManifest(manifest({ slug: "Bad Slug", category: "bad" as never }));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("kebab-case");
    expect(result.errors.join("\n")).toContain("category");
  });

  it("requires secret fields and oauth config to be declared", () => {
    expect(validateConnectorManifest(manifest({ secretFields: ["missing"] })).errors.join("\n")).toContain("secret field missing");
    expect(validateConnectorManifest(manifest({ authType: "oauth2", oauth: undefined })).errors.join("\n")).toContain("oauth2 connectors");
  });

  it("rejects side-effect and financial/destructive operations that default to allow", () => {
    const result = validateConnectorManifest(manifest({
      operations: [{
        slug: "charge",
        label: "Charge",
        inputSchema: { type: "object", properties: { amount: { type: "number" } } },
        outputSummary: "Creates a charge.",
        governance: { effectType: "financial", defaultDecision: "allow", riskTier: "high" },
        handler: async () => ({}),
      }],
    }));
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("cannot default to allow");
  });
});
