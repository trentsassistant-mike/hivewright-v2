/**
 * Sprint 6 WP2: billable usage read-path coverage.
 *
 * Verifies that the canonical billable usage fields (freshInputTokens,
 * cachedInputTokens, cachedInputTokensKnown, totalContextTokens,
 * estimatedBillableCostCents) are exposed by the task, supervisor-report,
 * and analytics API routes, and that processed context is visibly separate
 * from estimated billable cost in each response.
 *
 * Legacy fields (tokensInput, tokensOutput, costCents) must remain present
 * for compatibility — they are checked alongside the new fields.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { GET as getTasks } from "@/app/api/tasks/route";
import { GET as getTaskById } from "@/app/api/tasks/[id]/route";
import { GET as getSupervisorReports } from "@/app/api/supervisor-reports/route";
import { GET as getAnalytics } from "@/app/api/analytics/route";
import { toNaiveLocalTimestamp } from "@/app/api/analytics/time";
import { testSql as db, truncateAll } from "../_lib/test-db";

const TEST_PREFIX = "billable-wp2-";
let hiveId: string;

beforeEach(async () => {
  await truncateAll(db);
  const [hive] = await db`
    INSERT INTO hives (slug, name, type)
    VALUES (${TEST_PREFIX + "hive"}, ${TEST_PREFIX + "Hive"}, 'digital')
    RETURNING id
  `;
  hiveId = hive.id;
});

// ---------------------------------------------------------------------------
// Helper: insert a task with full billable usage fields
// ---------------------------------------------------------------------------
async function insertTaskWithBillableUsage(opts: {
  freshInputTokens?: number;
  cachedInputTokens?: number;
  cachedInputTokensKnown?: boolean;
  totalContextTokens?: number;
  estimatedBillableCostCents?: number;
  tokensInput?: number;
  tokensOutput?: number;
  costCents?: number;
}): Promise<string> {
  const {
    freshInputTokens = 800,
    cachedInputTokens = 200,
    cachedInputTokensKnown = true,
    totalContextTokens = 1000,
    estimatedBillableCostCents = 42,
    tokensInput = 1000,
    tokensOutput = 300,
    costCents = 55,
  } = opts;
  const [row] = await db`
    INSERT INTO tasks (
      hive_id, assigned_to, created_by, title, brief, priority,
      fresh_input_tokens, cached_input_tokens, cached_input_tokens_known,
      total_context_tokens, estimated_billable_cost_cents,
      tokens_input, tokens_output, cost_cents, status
    ) VALUES (
      ${hiveId}, 'dev-agent', 'test', ${TEST_PREFIX + "task"}, 'brief', 5,
      ${freshInputTokens}, ${cachedInputTokens}, ${cachedInputTokensKnown},
      ${totalContextTokens}, ${estimatedBillableCostCents},
      ${tokensInput}, ${tokensOutput}, ${costCents}, 'completed'
    )
    RETURNING id
  `;
  return row.id;
}

// ---------------------------------------------------------------------------
// GET /api/tasks — list endpoint
// ---------------------------------------------------------------------------
describe("GET /api/tasks — billable usage fields", () => {
  it("exposes all canonical billable fields in the task list", async () => {
    await insertTaskWithBillableUsage({
      freshInputTokens: 700,
      cachedInputTokens: 300,
      cachedInputTokensKnown: true,
      totalContextTokens: 1000,
      estimatedBillableCostCents: 38,
    });

    const res = await getTasks(
      new Request(`http://localhost/api/tasks?hiveId=${hiveId}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    const task = body.data[0];

    expect(task.freshInputTokens).toBe(700);
    expect(task.cachedInputTokens).toBe(300);
    expect(task.cachedInputTokensKnown).toBe(true);
    expect(task.totalContextTokens).toBe(1000);
    expect(task.estimatedBillableCostCents).toBe(38);
  });

  it("keeps legacy fields alongside billable fields for compatibility", async () => {
    await insertTaskWithBillableUsage({
      tokensInput: 1200,
      tokensOutput: 400,
      costCents: 60,
    });

    const res = await getTasks(
      new Request(`http://localhost/api/tasks?hiveId=${hiveId}`),
    );
    const body = await res.json();
    const task = body.data[0];

    // Legacy fields still present
    expect(task.tokensInput).toBe(1200);
    expect(task.tokensOutput).toBe(400);
    expect(task.costCents).toBe(60);
    // New billable fields also present
    expect(task).toHaveProperty("freshInputTokens");
    expect(task).toHaveProperty("estimatedBillableCostCents");
  });

  it("totalContextTokens is distinct from estimatedBillableCostCents", async () => {
    await insertTaskWithBillableUsage({
      totalContextTokens: 5000,
      estimatedBillableCostCents: 12,
    });

    const res = await getTasks(
      new Request(`http://localhost/api/tasks?hiveId=${hiveId}`),
    );
    const body = await res.json();
    const task = body.data[0];

    // Processed context (token count) is a different field from cost (cents)
    expect(task.totalContextTokens).toBe(5000);
    expect(task.estimatedBillableCostCents).toBe(12);
    expect(typeof task.totalContextTokens).toBe("number");
    expect(typeof task.estimatedBillableCostCents).toBe("number");
    // They are clearly distinct concepts — context tokens >> cents here
    expect(task.totalContextTokens).toBeGreaterThan(task.estimatedBillableCostCents);
  });

  it("returns null billable fields for tasks without usage data", async () => {
    await db`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, priority)
      VALUES (${hiveId}, 'dev-agent', 'test', ${TEST_PREFIX + "empty"}, 'no usage', 5)
    `;
    const res = await getTasks(
      new Request(`http://localhost/api/tasks?hiveId=${hiveId}`),
    );
    const body = await res.json();
    const task = body.data[0];

    expect(task.freshInputTokens).toBeNull();
    expect(task.cachedInputTokens).toBeNull();
    expect(task.totalContextTokens).toBeNull();
    expect(task.estimatedBillableCostCents).toBeNull();
    // cachedInputTokensKnown is false (or null on test DBs with pre-existing schema state)
    expect(task.cachedInputTokensKnown == null || task.cachedInputTokensKnown === false).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/tasks/[id] — detail endpoint
// ---------------------------------------------------------------------------
describe("GET /api/tasks/[id] — billable usage fields", () => {
  it("exposes billable fields in task detail", async () => {
    const taskId = await insertTaskWithBillableUsage({
      freshInputTokens: 600,
      cachedInputTokens: 400,
      cachedInputTokensKnown: true,
      totalContextTokens: 1000,
      estimatedBillableCostCents: 29,
      tokensInput: 1000,
      tokensOutput: 250,
      costCents: 35,
    });

    const res = await getTaskById(
      new Request(`http://localhost/api/tasks/${taskId}`),
      { params: Promise.resolve({ id: taskId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const task = body.data;

    expect(task.freshInputTokens).toBe(600);
    expect(task.cachedInputTokens).toBe(400);
    expect(task.cachedInputTokensKnown).toBe(true);
    expect(task.totalContextTokens).toBe(1000);
    expect(task.estimatedBillableCostCents).toBe(29);
    // Legacy fields preserved
    expect(task.tokensInput).toBe(1000);
    expect(task.tokensOutput).toBe(250);
    expect(task.costCents).toBe(35);
  });

  it("processed context and billable cost are separate response fields", async () => {
    const taskId = await insertTaskWithBillableUsage({
      totalContextTokens: 8000,
      estimatedBillableCostCents: 5,
    });

    const res = await getTaskById(
      new Request(`http://localhost/api/tasks/${taskId}`),
      { params: Promise.resolve({ id: taskId }) },
    );
    const body = await res.json();
    const task = body.data;

    // totalContextTokens is the total processed context in tokens
    expect(task.totalContextTokens).toBe(8000);
    // estimatedBillableCostCents is the monetary cost in cents
    expect(task.estimatedBillableCostCents).toBe(5);
    // These are clearly distinct: context is large, cost is small
    expect(task.totalContextTokens).not.toBe(task.estimatedBillableCostCents);
  });
});

// ---------------------------------------------------------------------------
// GET /api/supervisor-reports — billable usage on supervisor report rows
// ---------------------------------------------------------------------------
describe("GET /api/supervisor-reports — billable usage fields", () => {
  it("exposes billable fields on supervisor report rows", async () => {
    const report = {
      hiveId,
      scannedAt: new Date().toISOString(),
      findings: [],
      metrics: { openTasks: 0, activeGoals: 0, openDecisions: 0, tasksCompleted24h: 0, tasksFailed24h: 0 },
    };
    await db`
      INSERT INTO supervisor_reports (
        hive_id, report, ran_at,
        fresh_input_tokens, cached_input_tokens, cached_input_tokens_known,
        total_context_tokens, estimated_billable_cost_cents,
        tokens_input, tokens_output, cost_cents
      ) VALUES (
        ${hiveId}, ${db.json(report)}, NOW(),
        1200, 300, true,
        1500, 18,
        1500, 400, 22
      )
    `;

    const res = await getSupervisorReports(
      new Request(`http://localhost/api/supervisor-reports?hiveId=${hiveId}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    const row = body.data[0];

    expect(row.freshInputTokens).toBe(1200);
    expect(row.cachedInputTokens).toBe(300);
    expect(row.cachedInputTokensKnown).toBe(true);
    expect(row.totalContextTokens).toBe(1500);
    expect(row.estimatedBillableCostCents).toBe(18);
    // Legacy fields preserved
    expect(row.tokensInput).toBe(1500);
    expect(row.tokensOutput).toBe(400);
    expect(row.costCents).toBe(22);
  });

  it("totalContextTokens and estimatedBillableCostCents are separate fields", async () => {
    const report = {
      hiveId,
      scannedAt: new Date().toISOString(),
      findings: [],
      metrics: { openTasks: 0, activeGoals: 0, openDecisions: 0, tasksCompleted24h: 0, tasksFailed24h: 0 },
    };
    await db`
      INSERT INTO supervisor_reports (
        hive_id, report, ran_at,
        total_context_tokens, estimated_billable_cost_cents
      ) VALUES (
        ${hiveId}, ${db.json(report)}, NOW(),
        6000, 8
      )
    `;

    const res = await getSupervisorReports(
      new Request(`http://localhost/api/supervisor-reports?hiveId=${hiveId}`),
    );
    const body = await res.json();
    const row = body.data[0];

    expect(row.totalContextTokens).toBe(6000);
    expect(row.estimatedBillableCostCents).toBe(8);
    expect(row.totalContextTokens).not.toBe(row.estimatedBillableCostCents);
  });
});

// ---------------------------------------------------------------------------
// GET /api/analytics — aggregated billable token fields
// ---------------------------------------------------------------------------
describe("GET /api/analytics — billable aggregation fields", () => {
  it("includes totalContextTokens, totalFreshInputTokens, totalCachedInputTokens in totals", async () => {
    // Two tasks with billable usage
    const now = toNaiveLocalTimestamp(new Date());
    await db`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, priority, status,
        fresh_input_tokens, cached_input_tokens, cached_input_tokens_known,
        total_context_tokens, estimated_billable_cost_cents,
        tokens_input, tokens_output, cost_cents,
        created_at, updated_at
      ) VALUES
      (${hiveId}, 'dev-agent', 'test', ${TEST_PREFIX + "t1"}, 'b', 5, 'completed',
       500, 100, true, 600, 10, 600, 200, 12, ${now}, ${now}),
      (${hiveId}, 'dev-agent', 'test', ${TEST_PREFIX + "t2"}, 'b', 5, 'completed',
       400, 200, true, 600, 8, 600, 150, 10, ${now}, ${now})
    `;

    const res = await getAnalytics(
      new Request(`http://localhost/api/analytics?hiveId=${hiveId}&period=all`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.totals.totalContextTokens).toBe(1200);
    expect(body.data.totals.totalFreshInputTokens).toBe(900);
    expect(body.data.totals.totalCachedInputTokens).toBe(300);
    // estimatedBillableCostCents drives totalCostCents (preferred over legacy)
    expect(body.data.totals.totalCostCents).toBe(18);
  });

  it("falls back to legacy cost_cents when estimated_billable_cost_cents is absent", async () => {
    const now = toNaiveLocalTimestamp(new Date());
    await db`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, priority, status,
        tokens_input, tokens_output, cost_cents,
        created_at, updated_at
      ) VALUES (
        ${hiveId}, 'dev-agent', 'test', ${TEST_PREFIX + "legacy"}, 'b', 5, 'completed',
        800, 200, 25, ${now}, ${now}
      )
    `;

    const res = await getAnalytics(
      new Request(`http://localhost/api/analytics?hiveId=${hiveId}&period=all`),
    );
    const body = await res.json();
    // Falls back to legacy cost_cents = 25
    expect(body.data.totals.totalCostCents).toBe(25);
  });

  it("byRole breakdown includes totalContextTokens and billable token breakdown", async () => {
    const now = toNaiveLocalTimestamp(new Date());
    await db`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, priority, status,
        fresh_input_tokens, cached_input_tokens, total_context_tokens,
        estimated_billable_cost_cents, tokens_input, tokens_output, cost_cents,
        created_at, updated_at
      ) VALUES (
        ${hiveId}, 'qa', 'test', ${TEST_PREFIX + "qa-task"}, 'b', 5, 'completed',
        300, 100, 400, 5, 400, 100, 7, ${now}, ${now}
      )
    `;

    const res = await getAnalytics(
      new Request(`http://localhost/api/analytics?hiveId=${hiveId}&period=all`),
    );
    const body = await res.json();
    const qaRole = body.data.byRole.find(
      (r: { assignedTo: string }) => r.assignedTo === "qa",
    );
    expect(qaRole).toBeDefined();
    expect(qaRole.totalContextTokens).toBe(400);
    expect(qaRole.totalFreshInputTokens).toBe(300);
    expect(qaRole.totalCachedInputTokens).toBe(100);
    // Cost uses estimatedBillableCostCents
    expect(qaRole.totalCostCents).toBe(5);
  });
});
