import { describe, expect, it, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

beforeEach(async () => {
  await truncateAll(sql);
});

async function seedActionGovernanceFixture() {
  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type)
    VALUES ('action-governance-schema', 'Action Governance Schema', 'digital')
    RETURNING id
  `;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('action-governance-role', 'Action Governance Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  const [goal] = await sql<{ id: string }[]>`
    INSERT INTO goals (hive_id, title, description)
    VALUES (${hive.id}, 'Govern external actions', 'Verify ledger durability')
    RETURNING id
  `;

  const [task] = await sql<{ id: string }[]>`
    INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id)
    VALUES (${hive.id}, 'action-governance-role', 'owner', 'Request action', 'Propose an external action', ${goal.id})
    RETURNING id
  `;

  const [decision] = await sql<{ id: string }[]>`
    INSERT INTO decisions (hive_id, goal_id, task_id, title, context)
    VALUES (${hive.id}, ${goal.id}, ${task.id}, 'Approve external action?', 'Owner approval gate')
    RETURNING id
  `;

  return { hive, goal, task, decision };
}

describe("action governance schema", () => {
  it("stores hive-scoped action policies with generic effects and object conditions", async () => {
    const { hive } = await seedActionGovernanceFixture();

    const [policy] = await sql<{
      hive_id: string;
      connector: string;
      operation: string;
      effect: string;
      role_slug: string;
      conditions: Record<string, unknown>;
    }[]>`
      INSERT INTO action_policies (hive_id, connector, operation, effect, role_slug)
      VALUES (${hive.id}, 'generic.connector', 'generic.operation', 'require_approval', 'action-governance-role')
      RETURNING hive_id, connector, operation, effect, role_slug, conditions
    `;

    expect(policy).toMatchObject({
      hive_id: hive.id,
      connector: "generic.connector",
      operation: "generic.operation",
      effect: "require_approval",
      role_slug: "action-governance-role",
      conditions: {},
    });

    await expect(sql`
      INSERT INTO action_policies (hive_id, connector, operation, effect, conditions)
      VALUES (${hive.id}, 'generic.connector', 'generic.operation', 'prompt_owner', '{}'::jsonb)
    `).rejects.toThrow();

    await expect(sql`
      INSERT INTO action_policies (hive_id, connector, operation, effect, conditions)
      VALUES (${hive.id}, 'generic.connector', 'generic.operation', 'allow', '[]'::jsonb)
    `).rejects.toThrow();
  });

  it("stores external action requests with lifecycle states, object payload defaults, and per-hive idempotency", async () => {
    const { hive, goal, task, decision } = await seedActionGovernanceFixture();

    const [policy] = await sql<{ id: string }[]>`
      INSERT INTO action_policies (hive_id, connector, operation, effect, role_slug, conditions)
      VALUES (${hive.id}, 'generic.connector', 'generic.operation', 'require_approval', 'action-governance-role', ${sql.json({ reason: "test" })})
      RETURNING id
    `;

    const [request] = await sql<{
      hive_id: string;
      task_id: string;
      goal_id: string;
      decision_id: string;
      policy_id: string;
      state: string;
      request_payload: Record<string, unknown>;
      response_payload: Record<string, unknown>;
      policy_snapshot: Record<string, unknown>;
      execution_metadata: Record<string, unknown>;
    }[]>`
      INSERT INTO external_action_requests (
        hive_id,
        task_id,
        goal_id,
        decision_id,
        policy_id,
        connector,
        operation,
        role_slug,
        state,
        idempotency_key
      )
      VALUES (
        ${hive.id},
        ${task.id},
        ${goal.id},
        ${decision.id},
        ${policy.id},
        'generic.connector',
        'generic.operation',
        'action-governance-role',
        'awaiting_approval',
        'same-action-key'
      )
      RETURNING hive_id, task_id, goal_id, decision_id, policy_id, state,
        request_payload, response_payload, policy_snapshot, execution_metadata
    `;

    expect(request).toMatchObject({
      hive_id: hive.id,
      task_id: task.id,
      goal_id: goal.id,
      decision_id: decision.id,
      policy_id: policy.id,
      state: "awaiting_approval",
      request_payload: {},
      response_payload: {},
      policy_snapshot: {},
      execution_metadata: {},
    });

    for (const state of [
      "proposed",
      "blocked",
      "approved",
      "rejected",
      "executing",
      "succeeded",
      "failed",
      "cancelled",
    ]) {
      await sql`
        INSERT INTO external_action_requests (hive_id, connector, operation, state, idempotency_key)
        VALUES (${hive.id}, 'generic.connector', 'generic.operation', ${state}, ${`key-${state}`})
      `;
    }

    await expect(sql`
      INSERT INTO external_action_requests (hive_id, connector, operation, state)
      VALUES (${hive.id}, 'generic.connector', 'generic.operation', 'waiting')
    `).rejects.toThrow();

    await expect(sql`
      INSERT INTO external_action_requests (hive_id, connector, operation, state, idempotency_key)
      VALUES (${hive.id}, 'generic.connector', 'generic.operation', 'proposed', 'same-action-key')
    `).rejects.toThrow();

    const [otherHive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('action-governance-schema-other', 'Other Hive', 'digital')
      RETURNING id
    `;
    await sql`
      INSERT INTO external_action_requests (hive_id, connector, operation, state, idempotency_key)
      VALUES (${otherHive.id}, 'generic.connector', 'generic.operation', 'proposed', 'same-action-key')
    `;

    await expect(sql`
      INSERT INTO external_action_requests (hive_id, connector, operation, state, request_payload)
      VALUES (${hive.id}, 'generic.connector', 'generic.operation', 'proposed', '[]'::jsonb)
    `).rejects.toThrow();
  });

  it("keeps ledger rows after task, goal, decision, and policy deletion but cascades with hive deletion", async () => {
    const { hive, goal, task, decision } = await seedActionGovernanceFixture();
    const [policy] = await sql<{ id: string }[]>`
      INSERT INTO action_policies (hive_id, connector, operation, effect)
      VALUES (${hive.id}, 'generic.connector', 'generic.operation', 'allow')
      RETURNING id
    `;
    const [request] = await sql<{ id: string }[]>`
      INSERT INTO external_action_requests (
        hive_id, task_id, goal_id, decision_id, policy_id, connector, operation, state
      )
      VALUES (
        ${hive.id}, ${task.id}, ${goal.id}, ${decision.id}, ${policy.id},
        'generic.connector', 'generic.operation', 'proposed'
      )
      RETURNING id
    `;

    await sql`DELETE FROM decisions WHERE id = ${decision.id}`;
    await sql`DELETE FROM tasks WHERE id = ${task.id}`;
    await sql`DELETE FROM goals WHERE id = ${goal.id}`;
    await sql`DELETE FROM action_policies WHERE id = ${policy.id}`;

    const [surviving] = await sql<{
      task_id: string | null;
      goal_id: string | null;
      decision_id: string | null;
      policy_id: string | null;
    }[]>`
      SELECT task_id, goal_id, decision_id, policy_id
      FROM external_action_requests
      WHERE id = ${request.id}
    `;
    expect(surviving).toEqual({
      task_id: null,
      goal_id: null,
      decision_id: null,
      policy_id: null,
    });

    await sql`DELETE FROM hives WHERE id = ${hive.id}`;
    const [count] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM external_action_requests WHERE id = ${request.id}
    `;
    expect(count.count).toBe(0);
  });
});
