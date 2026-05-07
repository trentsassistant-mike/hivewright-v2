import { describe, it, expect, beforeEach } from "vitest";
import type { JSONValue } from "postgres";
import { GET } from "@/app/api/brief/route";
import { testSql as sql, truncateAll } from "../../_lib/test-db";

/**
 * /api/brief `recentCompletions` must hide zero-action hive-supervisor
 * heartbeats from the operator feed. The Supervisor findings panel already
 * surfaces heartbeat activity numerically; listing every noop heartbeat in
 * "Recently completed" just displaces actionable rows under the LIMIT 8
 * window. Heartbeats that DID emit applied non-noop outcomes remain visible.
 */

const HIVE = "cccccccc-0000-0000-0000-000000000030";

interface RecentCompletion {
  id: string;
  title: string;
  role: string;
  completedAt: string;
}

async function seedRoleTemplates(): Promise<void> {
  const slugs: Array<[string, string, string]> = [
    ["dev-agent", "Dev Agent", "executor"],
    ["hive-supervisor", "Hive Supervisor", "system"],
  ];
  for (const [slug, name, type] of slugs) {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES (${slug}, ${name}, ${type}, 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;
  }
}

async function seedHive(): Promise<void> {
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE}, 'recent-completions-hive', 'Recent Completions', 'digital')
  `;
}

async function insertCompletedTask(
  role: string,
  title: string,
  minutesAgo: number,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO tasks (
      hive_id, assigned_to, created_by, status, priority, title, brief,
      updated_at
    )
    VALUES (
      ${HIVE}::uuid,
      ${role},
      'test',
      'completed',
      5,
      ${title},
      'brief',
      NOW() - (${minutesAgo}::int * INTERVAL '1 minute')
    )
    RETURNING id
  `;
  return row.id;
}

async function insertSupervisorReport(
  taskId: string | null,
  actionOutcomes: JSONValue | null,
): Promise<void> {
  await sql`
    INSERT INTO supervisor_reports (
      hive_id, ran_at, report, actions, action_outcomes, agent_task_id
    )
    VALUES (
      ${HIVE}::uuid,
      NOW(),
      ${sql.json({
        hiveId: HIVE,
        scannedAt: new Date().toISOString(),
        findings: [],
        metrics: {
          openTasks: 0,
          activeGoals: 0,
          openDecisions: 0,
          tasksCompleted24h: 0,
          tasksFailed24h: 0,
        },
      })},
      ${sql.json({ summary: "s", findings_addressed: [], actions: [] })},
      ${actionOutcomes === null ? null : sql.json(actionOutcomes)},
      ${taskId}
    )
  `;
}

async function briefCompletions(): Promise<RecentCompletion[]> {
  const res = await GET(
    new Request(`http://localhost/api/brief?hiveId=${HIVE}`),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { recentCompletions: RecentCompletion[] };
  };
  return body.data.recentCompletions;
}

beforeEach(async () => {
  await truncateAll(sql);
  await seedRoleTemplates();
  await seedHive();
});

describe("GET /api/brief — recentCompletions hive-supervisor filter", () => {
  it("keeps completed non-supervisor tasks", async () => {
    const taskId = await insertCompletedTask("dev-agent", "ship the feature", 10);
    const completions = await briefCompletions();
    expect(completions.map((t) => t.id)).toContain(taskId);
  });

  it("hides a zero-action hive-supervisor heartbeat with empty outcomes", async () => {
    const heartbeatId = await insertCompletedTask("hive-supervisor", "Hive Supervisor heartbeat", 5);
    await insertSupervisorReport(heartbeatId, []);
    const completions = await briefCompletions();
    expect(completions.map((t) => t.id)).not.toContain(heartbeatId);
  });

  it("hides a hive-supervisor heartbeat whose report has NULL action_outcomes", async () => {
    const heartbeatId = await insertCompletedTask("hive-supervisor", "Hive Supervisor heartbeat", 5);
    await insertSupervisorReport(heartbeatId, null);
    const completions = await briefCompletions();
    expect(completions.map((t) => t.id)).not.toContain(heartbeatId);
  });

  it("hides a hive-supervisor task with no linked supervisor_reports row at all", async () => {
    // Edge case: the heartbeat completed but the finalize path never ran.
    // The Supervisor findings panel already signals this via the latest
    // report lag, so the Recent Completions feed should still hide it.
    const heartbeatId = await insertCompletedTask("hive-supervisor", "Hive Supervisor heartbeat", 5);
    const completions = await briefCompletions();
    expect(completions.map((t) => t.id)).not.toContain(heartbeatId);
  });

  it("hides a hive-supervisor heartbeat that only applied noop outcomes", async () => {
    const heartbeatId = await insertCompletedTask("hive-supervisor", "Hive Supervisor heartbeat", 5);
    await insertSupervisorReport(heartbeatId, [
      {
        action: { kind: "noop", reasoning: "logged" },
        status: "applied",
        detail: "",
      },
    ]);
    const completions = await briefCompletions();
    expect(completions.map((t) => t.id)).not.toContain(heartbeatId);
  });

  it("keeps a hive-supervisor heartbeat that actually applied a non-noop outcome", async () => {
    const heartbeatId = await insertCompletedTask("hive-supervisor", "Hive Supervisor heartbeat", 5);
    await insertSupervisorReport(heartbeatId, [
      {
        action: { kind: "create_decision", tier: 2, title: "t", context: "c" },
        status: "applied",
        detail: "",
      },
    ]);
    const completions = await briefCompletions();
    const hit = completions.find((t) => t.id === heartbeatId);
    expect(hit).toBeDefined();
    expect(hit!.role).toBe("hive-supervisor");
  });

  it("does not hide non-supervisor tasks even if they happen to have no supervisor_reports row", async () => {
    const devTaskId = await insertCompletedTask("dev-agent", "dev work", 2);
    const completions = await briefCompletions();
    expect(completions.map((t) => t.id)).toContain(devTaskId);
  });

  // The feature exists because zero-action heartbeats were eating the
  // LIMIT 8 window — they run every few minutes and are always the most
  // recent completions, so without the filter they pushed every real
  // completion off the feed. Regression guard: 10 noop heartbeats (newer)
  // next to 8 real dev completions (older) must leave the feed holding
  // exactly the 8 dev completions.
  it("hides zero-action heartbeats so the LIMIT 8 window fills with real completions even when newer heartbeats dominate by count", async () => {
    // 10 fresh zero-action heartbeats — newest rows in the hive.
    for (let i = 0; i < 10; i++) {
      const heartbeatId = await insertCompletedTask(
        "hive-supervisor",
        `heartbeat ${i}`,
        i, // i minutes ago — all fresher than any dev task
      );
      await insertSupervisorReport(heartbeatId, []);
    }
    // 8 real dev completions, all older than every heartbeat.
    const devIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      devIds.push(
        await insertCompletedTask("dev-agent", `real work ${i}`, 30 + i),
      );
    }

    const completions = await briefCompletions();
    expect(completions).toHaveLength(8);
    expect(new Set(completions.map((t) => t.id))).toEqual(new Set(devIds));
    expect(completions.every((t) => t.role === "dev-agent")).toBe(true);
  });
});
