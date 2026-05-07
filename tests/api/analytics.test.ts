import { describe, it, expect, beforeEach } from "vitest";
import { GET as getAnalytics, toNaiveLocalTimestamp } from "@/app/api/analytics/route";
import { testSql as db, truncateAll } from "../_lib/test-db";

const TEST_PREFIX = "analytics-";

let hiveId: string;
let goalIdA: string;
let goalIdB: string;

async function insertTask(opts: {
  assignedTo: string;
  status?: string;
  costCents?: number;
  tokensInput?: number;
  tokensOutput?: number;
  modelUsed?: string;
  goalId?: string | null;
  createdAt?: string | Date;
}) {
  const {
    assignedTo,
    status = "completed",
    costCents = 0,
    tokensInput = 0,
    tokensOutput = 0,
    modelUsed = null,
    goalId = null,
    createdAt,
  } = opts;
  // Match production: `tasks.created_at` is `timestamp without time zone` filled
  // by Postgres `now()` — i.e., server-local wall-clock. Tests must use the
  // same naive-local convention or period thresholds won't match stored rows.
  const created =
    createdAt instanceof Date
      ? toNaiveLocalTimestamp(createdAt)
      : createdAt ?? toNaiveLocalTimestamp(new Date());
  await db`
    INSERT INTO tasks (
      hive_id, assigned_to, created_by, title, brief,
      priority, goal_id, status, cost_cents, tokens_input, tokens_output, model_used,
      created_at, updated_at
    ) VALUES (
      ${hiveId}, ${assignedTo}, 'test', ${TEST_PREFIX + "t"}, 'brief',
      5, ${goalId}, ${status}, ${costCents}, ${tokensInput}, ${tokensOutput}, ${modelUsed},
      ${created}, ${created}
    )
  `;
}

beforeEach(async () => {
  await truncateAll(db);

  const [hive] = await db`
    INSERT INTO hives (slug, name, type, description)
    VALUES (${TEST_PREFIX + "biz"}, ${TEST_PREFIX + "Hive"}, 'service', 'test')
    RETURNING id
  `;
  hiveId = hive.id;

  const [ga] = await db`
    INSERT INTO goals (hive_id, title) VALUES (${hiveId}, 'Goal A') RETURNING id
  `;
  const [gb] = await db`
    INSERT INTO goals (hive_id, title) VALUES (${hiveId}, 'Goal B') RETURNING id
  `;
  goalIdA = ga.id;
  goalIdB = gb.id;
});

describe("GET /api/analytics", () => {
  it("returns 400 when hiveId is missing", async () => {
    const req = new Request("http://localhost:3000/api/analytics");
    const res = await getAnalytics(req);
    expect(res.status).toBe(400);
  });

  it("returns zeros for a hive with no tasks", async () => {
    const req = new Request(`http://localhost:3000/api/analytics?hiveId=${hiveId}`);
    const res = await getAnalytics(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totals).toEqual({
      totalTasks: 0,
      completed: 0,
      failed: 0,
      totalCostCents: 0,
      totalContextTokens: 0,
      totalFreshInputTokens: 0,
      totalCachedInputTokens: 0,
    });
    expect(body.data.byRole).toEqual([]);
    expect(body.data.byGoal).toEqual([]);
  });

  it("aggregates tasks beyond the 50-row pagination cap that previously truncated analytics", async () => {
    // Insert 75 tasks — more than the old /api/tasks default limit of 50.
    for (let i = 0; i < 75; i++) {
      await insertTask({
        assignedTo: "dev-agent",
        status: "completed",
        costCents: 100,
        tokensInput: 1000,
        tokensOutput: 500,
      });
    }

    const req = new Request(`http://localhost:3000/api/analytics?hiveId=${hiveId}&period=all`);
    const res = await getAnalytics(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totals.totalTasks).toBe(75);
    expect(body.data.totals.completed).toBe(75);
    expect(body.data.totals.totalCostCents).toBe(75 * 100);
    expect(body.data.byRole).toHaveLength(1);
    expect(body.data.byRole[0]).toMatchObject({
      assignedTo: "dev-agent",
      taskCount: 75,
      totalCostCents: 75 * 100,
      totalTokensInput: 75 * 1000,
      totalTokensOutput: 75 * 500,
    });
  });

  it("filters by period and excludes tasks outside the range", async () => {
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);

    await insertTask({ assignedTo: "dev-agent", costCents: 10, createdAt: fiveMinutesAgo });
    await insertTask({ assignedTo: "dev-agent", costCents: 20, createdAt: threeDaysAgo });
    await insertTask({ assignedTo: "dev-agent", costCents: 40, createdAt: tenDaysAgo });
    await insertTask({ assignedTo: "dev-agent", costCents: 80, createdAt: fortyDaysAgo });

    const fetchPeriod = async (p: string) => {
      const r = await getAnalytics(
        new Request(`http://localhost:3000/api/analytics?hiveId=${hiveId}&period=${p}`),
      );
      return (await r.json()).data;
    };

    const todayData = await fetchPeriod("today");
    expect(todayData.totals.totalTasks).toBe(1);
    expect(todayData.totals.totalCostCents).toBe(10);

    const sevenDayData = await fetchPeriod("7d");
    expect(sevenDayData.totals.totalTasks).toBe(2);
    expect(sevenDayData.totals.totalCostCents).toBe(30);

    const thirtyDayData = await fetchPeriod("30d");
    expect(thirtyDayData.totals.totalTasks).toBe(3);
    expect(thirtyDayData.totals.totalCostCents).toBe(70);

    const allData = await fetchPeriod("all");
    expect(allData.totals.totalTasks).toBe(4);
    expect(allData.totals.totalCostCents).toBe(150);
  });

  it("counts completed and failed separately and joins goal titles", async () => {
    await insertTask({ assignedTo: "dev-agent", status: "completed", costCents: 5, goalId: goalIdA });
    await insertTask({ assignedTo: "dev-agent", status: "completed", costCents: 5, goalId: goalIdA });
    await insertTask({ assignedTo: "dev-agent", status: "failed", costCents: 3, goalId: goalIdB });
    await insertTask({ assignedTo: "dev-agent", status: "active", costCents: 1, goalId: null });

    const res = await getAnalytics(
      new Request(`http://localhost:3000/api/analytics?hiveId=${hiveId}&period=all`),
    );
    const body = await res.json();
    expect(body.data.totals.completed).toBe(2);
    expect(body.data.totals.failed).toBe(1);
    expect(body.data.totals.totalTasks).toBe(4);

    const goalA = body.data.byGoal.find((g: { goalId: string }) => g.goalId === goalIdA);
    const goalB = body.data.byGoal.find((g: { goalId: string }) => g.goalId === goalIdB);
    expect(goalA).toMatchObject({ goalTitle: "Goal A", taskCount: 2, totalCostCents: 10 });
    expect(goalB).toMatchObject({ goalTitle: "Goal B", taskCount: 1, totalCostCents: 3 });
  });

  it("falls back to token-based pricing when cost_cents is zero", async () => {
    await insertTask({
      assignedTo: "dev-agent",
      status: "completed",
      costCents: 0,
      tokensInput: 10_000,
      tokensOutput: 2_000,
      modelUsed: "anthropic/claude-sonnet-4-6",
    });

    const res = await getAnalytics(
      new Request(`http://localhost:3000/api/analytics?hiveId=${hiveId}&period=all`),
    );
    const body = await res.json();
    // pricing: input 0.3/1k, output 1.5/1k -> 10 * 0.3 + 2 * 1.5 = 6 cents
    expect(body.data.totals.totalCostCents).toBe(6);
  });

  it("falls back to GPT-5.5 token pricing when cost_cents is zero", async () => {
    await insertTask({
      assignedTo: "dev-agent",
      status: "completed",
      costCents: 0,
      tokensInput: 1_000,
      tokensOutput: 1_000,
      modelUsed: "openai/gpt-5.5",
    });

    const res = await getAnalytics(
      new Request(`http://localhost:3000/api/analytics?hiveId=${hiveId}&period=all`),
    );
    const body = await res.json();
    expect(body.data.totals.totalCostCents).toBe(4);
  });

  it("'today' threshold uses server-local midnight (not UTC) and excludes yesterday-afternoon rows", async () => {
    // `tasks.created_at` is `timestamp without time zone` populated by Postgres
    // `now()` (server-local wall-clock). The dashboard owner only views one TZ, so
    // "today" must mean "since 00:00 local." A prior implementation passed the
    // threshold as `from.toISOString()` — Postgres then stripped the `Z` and
    // compared as naive, producing a TZ-sized drift that treated rows from
    // yesterday afternoon (UTC-offset hours before local midnight) as "today."
    const now = new Date();
    const localMidnightToday = new Date(now);
    localMidnightToday.setHours(0, 0, 0, 0);

    // A row one hour before local midnight today (yesterday in local time). Under
    // the old UTC-threshold bug on any positive-UTC offset server, this row
    // would leak into "today" counts.
    const yesterdayJustBeforeMidnight = new Date(localMidnightToday.getTime() - 60 * 60 * 1000);

    // A row five minutes before now (squarely inside "today" local).
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

    await insertTask({
      assignedTo: "dev-agent",
      costCents: 999,
      createdAt: yesterdayJustBeforeMidnight,
    });
    await insertTask({ assignedTo: "dev-agent", costCents: 1, createdAt: fiveMinutesAgo });

    const res = await getAnalytics(
      new Request(`http://localhost:3000/api/analytics?hiveId=${hiveId}&period=today`),
    );
    const body = await res.json();
    expect(body.data.totals.totalTasks).toBe(1);
    expect(body.data.totals.totalCostCents).toBe(1);
  });

  it("isolates analytics per hive", async () => {
    const [otherHive] = await db`
      INSERT INTO hives (slug, name, type, description)
      VALUES (${TEST_PREFIX + "other"}, ${TEST_PREFIX + "Other"}, 'service', 'other')
      RETURNING id
    `;
    await insertTask({ assignedTo: "dev-agent", costCents: 100 });
    await db`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, priority, status, cost_cents)
      VALUES (${otherHive.id}, 'dev-agent', 'test', 'other', 'brief', 5, 'completed', 999)
    `;

    const res = await getAnalytics(
      new Request(`http://localhost:3000/api/analytics?hiveId=${hiveId}&period=all`),
    );
    const body = await res.json();
    expect(body.data.totals.totalTasks).toBe(1);
    expect(body.data.totals.totalCostCents).toBe(100);
  });
});
