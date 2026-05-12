import { beforeEach, describe, expect, it, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { GET, PATCH } from "../../src/app/api/action-policies/route";

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(async () => true),
  canMutateHive: vi.fn(async () => true),
}));

async function seedHive(): Promise<string> {
  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (name, slug, type, description)
    VALUES ('Policy Hive', 'policy-hive', 'digital', 'Policy test hive')
    RETURNING id
  `;
  return hive.id;
}

function patchReq(body: unknown): Request {
  return new Request("http://t/api/action-policies", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/action-policies", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("returns hive policies and connector operation governance metadata", async () => {
    const hiveId = await seedHive();
    await sql`
      INSERT INTO action_policies (
        hive_id, name, enabled, connector, operation, effect_type, role_slug,
        effect, priority, reason, conditions, created_by
      )
      VALUES (
        ${hiveId}::uuid, 'Require approval for Discord send', true,
        'discord-webhook', 'send-message', 'notify', null,
        'require_approval', 50, 'Human review first', '{"maxAmount":100}'::jsonb, 'test-user'
      )
    `;

    const res = await GET(new Request(`http://t/api/action-policies?hiveId=${hiveId}`));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.policies).toHaveLength(1);
    expect(body.data.policies[0]).toMatchObject({
      hiveId,
      name: "Require approval for Discord send",
      enabled: true,
      connectorSlug: "discord-webhook",
      operation: "send-message",
      effectType: "notify",
      decision: "require_approval",
      priority: 50,
      reason: "Human review first",
      conditions: { maxAmount: 100 },
    });
    expect(body.data.connectors.length).toBeGreaterThan(0);
    expect(body.data.connectors[0].operations[0].governance).toEqual(
      expect.objectContaining({
        effectType: expect.any(String),
        defaultDecision: expect.stringMatching(/^(allow|require_approval|block)$/),
      }),
    );
  });

  it("replaces hive policies with a validated generic policy array", async () => {
    const hiveId = await seedHive();
    await sql`
      INSERT INTO action_policies (hive_id, name, connector, operation, effect, conditions)
      VALUES (${hiveId}::uuid, 'Old policy', 'legacy', 'legacy-op', 'block', '{}'::jsonb)
    `;

    const res = await PATCH(patchReq({
      hiveId,
      policies: [
        {
          name: "Allow low-risk read operations",
          enabled: true,
          connectorSlug: null,
          operation: null,
          effectType: "read",
          roleSlug: null,
          decision: "allow",
          priority: 10,
          reason: null,
          conditions: {
            riskTierAtMost: "low",
            businessHoursOnly: true,
          },
        },
        {
          name: "Block dangerous role action",
          enabled: false,
          connectorSlug: "stripe",
          operation: "refund-payment",
          effectType: "financial",
          roleSlug: "dev-agent",
          decision: "block",
          priority: 99,
          reason: "Owner review pending",
          conditions: {},
        },
      ],
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.policies.map((policy: { name: string }) => policy.name)).toEqual([
      "Block dangerous role action",
      "Allow low-risk read operations",
    ]);

    const rows = await sql<{ name: string; connector: string | null; operation: string | null; effect: string; priority: number }[]>`
      SELECT name, connector, operation, effect, priority
      FROM action_policies
      WHERE hive_id = ${hiveId}::uuid
      ORDER BY priority DESC, name ASC
    `;
    expect(rows).toEqual([
      {
        name: "Block dangerous role action",
        connector: "stripe",
        operation: "refund-payment",
        effect: "block",
        priority: 99,
      },
      {
        name: "Allow low-risk read operations",
        connector: null,
        operation: null,
        effect: "allow",
        priority: 10,
      },
    ]);
  });

  it("rejects invalid enum values and invalid condition fields", async () => {
    const hiveId = await seedHive();

    const invalidDecision = await PATCH(patchReq({
      hiveId,
      policies: [{
        name: "Bad",
        enabled: true,
        connectorSlug: null,
        operation: null,
        effectType: null,
        roleSlug: null,
        decision: "ask_owner",
        priority: 0,
        reason: null,
        conditions: {},
      }],
    }));
    expect(invalidDecision.status).toBe(400);

    const invalidConditions = await PATCH(patchReq({
      hiveId,
      policies: [{
        name: "Bad conditions",
        enabled: true,
        connectorSlug: null,
        operation: null,
        effectType: null,
        roleSlug: null,
        decision: "allow",
        priority: 0,
        reason: null,
        conditions: [],
      }],
    }));
    expect(invalidConditions.status).toBe(400);

    const unsupportedConditions = await PATCH(patchReq({
      hiveId,
      policies: [{
        name: "Scoped but unsupported",
        enabled: true,
        connectorSlug: null,
        operation: null,
        effectType: null,
        roleSlug: null,
        decision: "allow",
        priority: 0,
        reason: null,
        conditions: { amountGte: 500 },
      }],
    }));
    expect(unsupportedConditions.status).toBe(400);

    const invalidConditionType = await PATCH(patchReq({
      hiveId,
      policies: [{
        name: "Bad condition type",
        enabled: true,
        connectorSlug: null,
        operation: null,
        effectType: null,
        roleSlug: null,
        decision: "allow",
        priority: 0,
        reason: null,
        conditions: { allowedDomains: "example.com" },
      }],
    }));
    expect(invalidConditionType.status).toBe(400);
  });
});
