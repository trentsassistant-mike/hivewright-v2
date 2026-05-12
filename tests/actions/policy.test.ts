import { describe, expect, it } from "vitest";
import { evaluateActionPolicy } from "@/actions/policy";
import { redactActionPayload } from "@/actions/redaction";

const baseInput = {
  hiveId: "hive-1",
  connectorSlug: "github",
  operation: "issues.create",
  effectType: "external_write",
} as const;

describe("evaluateActionPolicy", () => {
  it("uses the connector operation default allow decision when no hive policy matches", () => {
    expect(
      evaluateActionPolicy({
        ...baseInput,
        defaultDecision: "allow",
        policies: [],
      }),
    ).toEqual({
      decision: "allow",
      reason: "connector operation default decision: allow",
    });
  });

  it("uses the connector operation default require_approval decision when no hive policy matches", () => {
    expect(
      evaluateActionPolicy({
        ...baseInput,
        defaultDecision: "require_approval",
        policies: [],
      }),
    ).toEqual({
      decision: "require_approval",
      reason: "connector operation default decision: require_approval",
    });
  });

  it("allows a matching hive policy to override a stricter connector default", () => {
    expect(
      evaluateActionPolicy({
        ...baseInput,
        defaultDecision: "require_approval",
        policies: [
          {
            id: "policy-allow",
            hiveId: "hive-1",
            connectorSlug: "github",
            operation: "issues.create",
            effectType: "external_write",
            roleSlug: null,
            decision: "allow",
            priority: 10,
            disabled: false,
          },
        ],
      }),
    ).toEqual({
      decision: "allow",
      reason: "matched action policy policy-allow",
      policyId: "policy-allow",
    });
  });

  it("blocks when the highest priority matching policy blocks", () => {
    expect(
      evaluateActionPolicy({
        ...baseInput,
        defaultDecision: "allow",
        policies: [
          {
            id: "policy-block",
            hiveId: "hive-1",
            connectorSlug: "github",
            operation: "issues.create",
            effectType: "external_write",
            roleSlug: null,
            decision: "block",
            priority: 100,
            disabled: false,
          },
          {
            id: "policy-allow",
            hiveId: "hive-1",
            connectorSlug: "github",
            operation: "issues.create",
            effectType: "external_write",
            roleSlug: null,
            decision: "allow",
            priority: 10,
            disabled: false,
          },
        ],
      }),
    ).toMatchObject({ decision: "block", policyId: "policy-block" });
  });

  it("breaks priority ties as block over require_approval over allow", () => {
    const policies = [
      {
        id: "policy-allow",
        hiveId: "hive-1",
        connectorSlug: null,
        operation: null,
        effectType: null,
        roleSlug: null,
        decision: "allow" as const,
        priority: 50,
        disabled: false,
      },
      {
        id: "policy-approval",
        hiveId: "hive-1",
        connectorSlug: null,
        operation: null,
        effectType: null,
        roleSlug: null,
        decision: "require_approval" as const,
        priority: 50,
        disabled: false,
      },
      {
        id: "policy-block",
        hiveId: "hive-1",
        connectorSlug: null,
        operation: null,
        effectType: null,
        roleSlug: null,
        decision: "block" as const,
        priority: 50,
        disabled: false,
      },
    ];

    expect(
      evaluateActionPolicy({
        ...baseInput,
        defaultDecision: "allow",
        policies,
      }),
    ).toMatchObject({ decision: "block", policyId: "policy-block" });
  });

  it("ignores disabled policies", () => {
    expect(
      evaluateActionPolicy({
        ...baseInput,
        defaultDecision: "allow",
        policies: [
          {
            id: "disabled-block",
            hiveId: "hive-1",
            connectorSlug: null,
            operation: null,
            effectType: null,
            roleSlug: null,
            decision: "block",
            priority: 1000,
            disabled: true,
          },
        ],
      }),
    ).toEqual({
      decision: "allow",
      reason: "connector operation default decision: allow",
    });
  });

  it("matches role-specific policies only for that actor role", () => {
    const policies = [
      {
        id: "researcher-block",
        hiveId: "hive-1",
        connectorSlug: "github",
        operation: "issues.create",
        effectType: "external_write",
        roleSlug: "researcher",
        decision: "block" as const,
        priority: 100,
        disabled: false,
      },
      {
        id: "engineer-approval",
        hiveId: "hive-1",
        connectorSlug: "github",
        operation: "issues.create",
        effectType: "external_write",
        roleSlug: "engineer",
        decision: "require_approval" as const,
        priority: 50,
        disabled: false,
      },
    ];

    expect(
      evaluateActionPolicy({
        ...baseInput,
        actorRoleSlug: "engineer",
        defaultDecision: "allow",
        policies,
      }),
    ).toMatchObject({ decision: "require_approval", policyId: "engineer-approval" });
  });

  it("ignores policies whose conditions do not match the action args", () => {
    expect(
      evaluateActionPolicy({
        ...baseInput,
        effectType: "financial",
        defaultDecision: "require_approval",
        args: { amount: 250 },
        riskTier: "medium",
        policies: [
          {
            id: "small-amount-allow",
            hiveId: "hive-1",
            connectorSlug: "github",
            operation: "issues.create",
            effectType: "financial",
            roleSlug: null,
            decision: "allow",
            priority: 100,
            disabled: false,
            conditions: { maxAmount: 100 },
          },
          {
            id: "financial-block",
            hiveId: "hive-1",
            connectorSlug: "github",
            operation: "issues.create",
            effectType: "financial",
            roleSlug: null,
            decision: "block",
            priority: 10,
            disabled: false,
          },
        ],
      }),
    ).toMatchObject({ decision: "block", policyId: "financial-block" });
  });
});

describe("redactActionPayload", () => {
  it("recursively redacts common secret keys while preserving non-sensitive fields", () => {
    expect(
      redactActionPayload({
        title: "Create issue",
        token: "ghp_secret",
        nested: {
          password: "p4ss",
          count: 3,
          accessToken: "access",
          child: [{ webhookUrl: "https://example.com/hook" }, { safe: true }],
        },
        headers: {
          authorization: "Bearer abc",
          authHeader: "Basic xyz",
          contentType: "application/json",
        },
        apiKey: "abc123",
        refreshToken: "refresh",
        secret: "shh",
      }),
    ).toEqual({
      title: "Create issue",
      token: "[REDACTED]",
      nested: {
        password: "[REDACTED]",
        count: 3,
        accessToken: "[REDACTED]",
        child: [{ webhookUrl: "[REDACTED]" }, { safe: true }],
      },
      headers: {
        authorization: "[REDACTED]",
        authHeader: "[REDACTED]",
        contentType: "application/json",
      },
      apiKey: "[REDACTED]",
      refreshToken: "[REDACTED]",
      secret: "[REDACTED]",
    });
  });
});
