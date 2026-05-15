import { describe, it, expect, beforeEach } from "vitest";
import { recordTaskCost, checkGoalBudget, checkAiBudget } from "@/dispatcher/cost-tracker";
import { calculateCostCents } from "@/adapters/provider-config";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;
let goalId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type, ai_budget_cap_cents)
    VALUES ('cost-test-biz', 'Cost Test', 'digital', 10000)
    RETURNING *
  `;
  bizId = biz.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('cost-test-role', 'CT Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, status, budget_cents)
    VALUES (${bizId}, 'cost-test-goal', 'active', 1000)
    RETURNING *
  `;
  goalId = goal.id;
});


describe("recordTaskCost", () => {
  it("persists canonical cache-aware usage fields and legacy compatibility mirrors", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'cost-test-role', 'owner', 'cost-test-cache-aware', 'Brief', 'active')
      RETURNING *
    `;

    await recordTaskCost(sql, task.id, {
      totalContextTokens: 1_000,
      freshInputTokens: 600,
      cachedInputTokens: 400,
      cacheCreationTokens: 125,
      cachedInputTokensKnown: true,
      tokensOutput: 250,
      estimatedBillableCostCents: 1,
      modelUsed: "openai/gpt-5.5",
    });

    const [updated] = await sql`
      SELECT
        fresh_input_tokens,
        cached_input_tokens,
        cached_input_tokens_known,
        tokens_output,
        total_context_tokens,
        estimated_billable_cost_cents,
        tokens_input,
        cost_cents,
        model_used,
        usage_details
      FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.fresh_input_tokens).toBe(600);
    expect(updated.cached_input_tokens).toBe(400);
    expect(updated.cached_input_tokens_known).toBe(true);
    expect(updated.tokens_output).toBe(250);
    expect(updated.total_context_tokens).toBe(1_000);
    expect(updated.estimated_billable_cost_cents).toBe(1);
    expect(updated.tokens_input).toBe(1_000);
    expect(updated.cost_cents).toBe(1);
    expect(updated.model_used).toBe("openai/gpt-5.5");
    expect(updated.usage_details).toEqual({
      totalInputTokens: 1_000,
      freshInputTokens: 600,
      outputTokens: 250,
      cacheReadTokens: 400,
      cacheCreationTokens: 125,
      cachedInputTokensKnown: true,
      estimatedBillableCostCents: 1,
    });
  });

  it("persists missing cache metadata conservatively", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'cost-test-role', 'owner', 'cost-test-missing-cache', 'Brief', 'active')
      RETURNING *
    `;

    await recordTaskCost(sql, task.id, {
      tokensInput: 1_000,
      tokensOutput: 250,
      costCents: 2,
      modelUsed: "openai/gpt-5.5",
    });

    const [updated] = await sql`
      SELECT
        fresh_input_tokens,
        cached_input_tokens,
        cached_input_tokens_known,
        total_context_tokens,
        estimated_billable_cost_cents,
        tokens_input,
        tokens_output,
        cost_cents
      FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.fresh_input_tokens).toBe(1_000);
    expect(updated.cached_input_tokens).toBe(0);
    expect(updated.cached_input_tokens_known).toBe(false);
    expect(updated.total_context_tokens).toBe(1_000);
    expect(updated.estimated_billable_cost_cents).toBe(2);
    expect(updated.tokens_input).toBe(1_000);
    expect(updated.tokens_output).toBe(250);
    expect(updated.cost_cents).toBe(2);
  });

  it("updates task with token counts and cost", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'cost-test-role', 'owner', 'cost-test-1', 'Brief', 'active')
      RETURNING *
    `;

    await recordTaskCost(sql, task.id, {
      tokensInput: 5000,
      tokensOutput: 2000,
      costCents: 45,
      modelUsed: "anthropic/claude-sonnet-4-6",
    });

    const [updated] = await sql`
      SELECT tokens_input, tokens_output, cost_cents, model_used
      FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.tokens_input).toBe(5000);
    expect(updated.tokens_output).toBe(2000);
    expect(updated.cost_cents).toBe(45);
    expect(updated.model_used).toBe("anthropic/claude-sonnet-4-6");
  });

  it("persists GPT-5.5 costs computed by the shared pricing path", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'cost-test-role', 'owner', 'cost-test-gpt55', 'Brief', 'active')
      RETURNING *
    `;

    const costCents = calculateCostCents("openai/gpt-5.5", 1_000, 1_000);

    await recordTaskCost(sql, task.id, {
      tokensInput: 1_000,
      tokensOutput: 1_000,
      costCents,
      modelUsed: "openai/gpt-5.5",
    });

    const [updated] = await sql`
      SELECT tokens_input, tokens_output, cost_cents, model_used
      FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.tokens_input).toBe(1_000);
    expect(updated.tokens_output).toBe(1_000);
    expect(updated.cost_cents).toBe(4);
    expect(updated.model_used).toBe("openai/gpt-5.5");
  });

  it("persists gpt-image-2 image generation costs through the shared task cost ledger", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'cost-test-role', 'owner', 'cost-test-image', 'Brief', 'active')
      RETURNING *
    `;

    const costCents = calculateCostCents("gpt-image-2-2026-04-21", 2_500, 1_000);

    await recordTaskCost(sql, task.id, {
      tokensInput: 2_500,
      tokensOutput: 1_000,
      costCents,
      modelUsed: "gpt-image-2-2026-04-21",
    });

    const [updated] = await sql`
      SELECT tokens_input, tokens_output, cost_cents, model_used
      FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.tokens_input).toBe(2_500);
    expect(updated.tokens_output).toBe(1_000);
    expect(updated.cost_cents).toBe(5);
    expect(updated.model_used).toBe("gpt-image-2-2026-04-21");
  });

  it("persists a zero-cent gpt-image-2 record when provider usage is missing", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'cost-test-role', 'owner', 'cost-test-image-missing-usage', 'Brief', 'active')
      RETURNING *
    `;

    await recordTaskCost(sql, task.id, {
      tokensInput: 0,
      tokensOutput: 0,
      costCents: 0,
      modelUsed: "gpt-image-2-2026-04-21",
    });

    const [updated] = await sql`
      SELECT tokens_input, tokens_output, cost_cents, model_used
      FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.tokens_input).toBe(0);
    expect(updated.tokens_output).toBe(0);
    expect(updated.cost_cents).toBe(0);
    expect(updated.model_used).toBe("gpt-image-2-2026-04-21");
  });

  it("persists Gemini 3.1 Pro Preview costs computed by the shared pricing path", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'cost-test-role', 'owner', 'cost-test-gemini31-pro-preview', 'Brief', 'active')
      RETURNING *
    `;

    const costCents = calculateCostCents("google/gemini-3.1-pro-preview", 10_000, 5_000);

    await recordTaskCost(sql, task.id, {
      tokensInput: 10_000,
      tokensOutput: 5_000,
      costCents,
      modelUsed: "google/gemini-3.1-pro-preview",
    });

    const [updated] = await sql`
      SELECT tokens_input, tokens_output, cost_cents, model_used
      FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.tokens_input).toBe(10_000);
    expect(updated.tokens_output).toBe(5_000);
    expect(updated.cost_cents).toBe(8);
    expect(updated.model_used).toBe("google/gemini-3.1-pro-preview");
  });

  it("persists Gemini 3 Flash Preview costs computed by the shared pricing path", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'cost-test-role', 'owner', 'cost-test-gemini3-flash-preview', 'Brief', 'active')
      RETURNING *
    `;

    const costCents = calculateCostCents("google/gemini-3-flash-preview", 10_000, 5_000);

    await recordTaskCost(sql, task.id, {
      tokensInput: 10_000,
      tokensOutput: 5_000,
      costCents,
      modelUsed: "google/gemini-3-flash-preview",
    });

    const [updated] = await sql`
      SELECT tokens_input, tokens_output, cost_cents, model_used
      FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.tokens_input).toBe(10_000);
    expect(updated.tokens_output).toBe(5_000);
    expect(updated.cost_cents).toBe(8);
    expect(updated.model_used).toBe("google/gemini-3-flash-preview");
  });

  it("persists Gemini 3.1 Flash Lite Preview costs computed by the shared pricing path", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'cost-test-role', 'owner', 'cost-test-gemini31-flash-lite-preview', 'Brief', 'active')
      RETURNING *
    `;

    const costCents = calculateCostCents("google/gemini-3.1-flash-lite-preview", 10_000, 5_000);

    await recordTaskCost(sql, task.id, {
      tokensInput: 10_000,
      tokensOutput: 5_000,
      costCents,
      modelUsed: "google/gemini-3.1-flash-lite-preview",
    });

    const [updated] = await sql`
      SELECT tokens_input, tokens_output, cost_cents, model_used
      FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.tokens_input).toBe(10_000);
    expect(updated.tokens_output).toBe(5_000);
    expect(updated.cost_cents).toBe(8);
    expect(updated.model_used).toBe("google/gemini-3.1-flash-lite-preview");
  });

  it("persists Mistral Large Latest costs computed by the shared pricing path", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'cost-test-role', 'owner', 'cost-test-mistral-large-latest', 'Brief', 'active')
      RETURNING *
    `;

    const costCents = calculateCostCents("mistral/mistral-large-latest", 10_000, 5_000);

    await recordTaskCost(sql, task.id, {
      tokensInput: 10_000,
      tokensOutput: 5_000,
      costCents,
      modelUsed: "mistral/mistral-large-latest",
    });

    const [updated] = await sql`
      SELECT tokens_input, tokens_output, cost_cents, model_used
      FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.tokens_input).toBe(10_000);
    expect(updated.tokens_output).toBe(5_000);
    expect(updated.cost_cents).toBe(1);
    expect(updated.model_used).toBe("mistral/mistral-large-latest");
  });

  it("persists Mistral OCR Latest costs computed by the shared pricing path", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'cost-test-role', 'owner', 'cost-test-mistral-ocr-latest', 'Brief', 'active')
      RETURNING *
    `;

    const costCents = calculateCostCents("mistral/mistral-ocr-latest", 10_000, 5_000);

    await recordTaskCost(sql, task.id, {
      tokensInput: 10_000,
      tokensOutput: 5_000,
      costCents,
      modelUsed: "mistral/mistral-ocr-latest",
    });

    const [updated] = await sql`
      SELECT tokens_input, tokens_output, cost_cents, model_used
      FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.tokens_input).toBe(10_000);
    expect(updated.tokens_output).toBe(5_000);
    expect(updated.cost_cents).toBe(1);
    expect(updated.model_used).toBe("mistral/mistral-ocr-latest");
  });

});

describe("checkGoalBudget", () => {
  it("persists warning state at 80 percent of the recorded cap", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, status, cost_cents)
      VALUES (${bizId}, 'cost-test-role', 'owner', 'cost-test-budget-warning', 'B', ${goalId}, 'completed', 800)
    `;

    const result = await checkGoalBudget(sql, goalId);
    expect(result.exceeded).toBe(false);
    expect(result.state).toBe("warning");
    expect(result.warning).toBe(true);
    expect(result.paused).toBe(false);
    expect(result.remainingCents).toBe(200);
    expect(result.percentUsed).toBe(80);

    const [goal] = await sql`
      SELECT status, budget_state, budget_warning_triggered_at, budget_enforced_at, budget_enforcement_reason
      FROM goals
      WHERE id = ${goalId}
    `;
    expect(goal.status).toBe("active");
    expect(goal.budget_state).toBe("warning");
    expect(goal.budget_warning_triggered_at).not.toBeNull();
    expect(goal.budget_enforced_at).toBeNull();
    expect(goal.budget_enforcement_reason).toBeNull();
  });

  it("returns under-budget when costs are within limit", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, status, cost_cents)
      VALUES (${bizId}, 'cost-test-role', 'owner', 'cost-test-budget1', 'B', ${goalId}, 'completed', 300)
    `;

    const result = await checkGoalBudget(sql, goalId);
    expect(result.exceeded).toBe(false);
    expect(result.spentCents).toBe(300);
    expect(result.budgetCents).toBe(1000);
    expect(result.state).toBe("ok");
    expect(result.warning).toBe(false);
    expect(result.paused).toBe(false);
  });

  it("returns exceeded when costs surpass budget", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, status, cost_cents)
      VALUES
        (${bizId}, 'cost-test-role', 'owner', 'cost-test-budget2a', 'B', ${goalId}, 'completed', 600),
        (${bizId}, 'cost-test-role', 'owner', 'cost-test-budget2b', 'B', ${goalId}, 'completed', 500)
    `;

    const result = await checkGoalBudget(sql, goalId);
    expect(result.exceeded).toBe(true);
    expect(result.spentCents).toBe(1100);
    expect(result.state).toBe("paused");
    expect(result.warning).toBe(true);
    expect(result.paused).toBe(true);
    expect(result.remainingCents).toBe(0);
    expect(result.percentUsed).toBe(110);

    const [goal] = await sql`
      SELECT status, budget_state, budget_warning_triggered_at, budget_enforced_at, budget_enforcement_reason
      FROM goals
      WHERE id = ${goalId}
    `;
    expect(goal.status).toBe("paused");
    expect(goal.budget_state).toBe("paused");
    expect(goal.budget_warning_triggered_at).not.toBeNull();
    expect(goal.budget_enforced_at).not.toBeNull();
    expect(goal.budget_enforcement_reason).toBe("Paused by budget");
  });

  it("updates the goal spent_cents column", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, status, cost_cents)
      VALUES (${bizId}, 'cost-test-role', 'owner', 'cost-test-budget3', 'B', ${goalId}, 'completed', 250)
    `;

    await checkGoalBudget(sql, goalId);

    const [goal] = await sql`SELECT spent_cents FROM goals WHERE id = ${goalId}`;
    expect(goal.spent_cents).toBe(250);
  });
});

describe("checkAiBudget", () => {
  it("pauses new work for the workspace after a breaching attempt completes", async () => {
    await sql`
      INSERT INTO tasks (
        hive_id,
        assigned_to,
        created_by,
        title,
        brief,
        status,
        estimated_billable_cost_cents
      )
      VALUES
        (${bizId}, 'cost-test-role', 'owner', 'pilot-budget-breach-a', 'A', 'completed', 6000),
        (${bizId}, 'cost-test-role', 'owner', 'pilot-budget-breach-b', 'B', 'completed', 4000)
    `;

    const result = await checkAiBudget(sql, bizId);
    expect(result.state).toBe("breached");
    expect(result.enforcement.blocksNewWork).toBe(true);
    expect(result.enforcement.mode).toBe("creation_pause");

    const [lock] = await sql`
      SELECT creation_paused, reason, paused_by, operating_state
      FROM hive_runtime_locks
      WHERE hive_id = ${bizId}
    `;
    expect(lock.creation_paused).toBe(true);
    expect(lock.reason).toBe("Paused by AI spend budget breach");
    expect(lock.paused_by).toBe("system:ai-budget");
    expect(lock.operating_state).toBe("paused");
  });
});
