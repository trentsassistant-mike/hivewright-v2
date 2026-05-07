import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { escalateMalformedSupervisorOutput } from "@/supervisor";

/**
 * The supervisor runtime has two decision-creating paths:
 *   1. An applied `create_decision` action from a parseable block
 *      (covered by apply-actions.test.ts — always `ea_review`).
 *   2. A malformed or missing fenced-JSON block from the agent itself —
 *      this is the fallback escalation and is EQUALLY owner-facing, so it
 *      MUST ALSO route through the EA buffer at `status='ea_review'`.
 *
 * If the malformed path ever regressed to `status='pending'`, a bug in
 * the supervisor agent would page the owner directly — exactly the kind
 * of owner-as-developer anti-pattern the EA-first rule exists to prevent.
 * These assertions lock that invariant in.
 */

const HIVE_ID = "11111111-1111-1111-1111-111111111111";

async function seedHive() {
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'test-hive', 'Test Hive', 'digital')
  `;
}

async function seedSupervisorReport(): Promise<string> {
  const report = {
    hiveId: HIVE_ID,
    scannedAt: "2026-04-21T00:00:00.000Z",
    findings: [
      {
        id: "stalled_task:aaa",
        kind: "stalled_task",
        severity: "warn",
        ref: {},
        summary: "stub",
        detail: {},
      },
    ],
    metrics: {
      openTasks: 1,
      activeGoals: 0,
      openDecisions: 0,
      tasksCompleted24h: 0,
      tasksFailed24h: 0,
    },
  };
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO supervisor_reports (hive_id, report)
    VALUES (${HIVE_ID}, ${sql.json(report)})
    RETURNING id
  `;
  return row.id;
}

beforeEach(async () => {
  await truncateAll(sql);
  await seedHive();
});

describe("escalateMalformedSupervisorOutput", () => {
  it("creates a decision with status='ea_review' (never pending)", async () => {
    const reportId = await seedSupervisorReport();

    await escalateMalformedSupervisorOutput(sql, {
      hiveId: HIVE_ID,
      reportId,
      reason: "No ```json block found in supervisor output.",
      rawOutput: "I reviewed the findings and decided nothing was needed.",
    });

    const rows = await sql<
      { status: string; priority: string; kind: string; title: string; context: string }[]
    >`
      SELECT status, priority, kind, title, context
      FROM decisions WHERE hive_id = ${HIVE_ID}
    `;
    expect(rows).toHaveLength(1);
    // Governance assertion — this must stay green.
    expect(rows[0].status).toBe("ea_review");
    expect(rows[0].status).not.toBe("pending");
    expect(rows[0].title).toMatch(/supervisor/i);
    expect(rows[0].context).toContain("No ```json block");
  });

  it("records the escalation on the supervisor_reports row's action_outcomes", async () => {
    const reportId = await seedSupervisorReport();

    await escalateMalformedSupervisorOutput(sql, {
      hiveId: HIVE_ID,
      reportId,
      reason: "Supervisor actions JSON malformed: Unexpected token.",
      rawOutput: "```json\n{not valid}\n```",
    });

    const [row] = await sql<
      { action_outcomes: unknown }[]
    >`
      SELECT action_outcomes FROM supervisor_reports WHERE id = ${reportId}
    `;
    expect(row.action_outcomes).toBeTruthy();
    const outcomes = row.action_outcomes as Array<{ status: string; detail: string }>;
    expect(outcomes.some((o) => o.status === "error")).toBe(true);
    expect(JSON.stringify(outcomes)).toMatch(/malformed|parse/i);
  });

  it("truncates very long raw output so the decisions.context row fits", async () => {
    const reportId = await seedSupervisorReport();
    const huge = "X".repeat(20_000);

    await escalateMalformedSupervisorOutput(sql, {
      hiveId: HIVE_ID,
      reportId,
      reason: "malformed",
      rawOutput: huge,
    });

    const [row] = await sql<{ context: string }[]>`
      SELECT context FROM decisions WHERE hive_id = ${HIVE_ID}
    `;
    // Guard against an unbounded raw-output dump flooding the decisions
    // table — context should be bounded (the exact cap can evolve, but
    // it must be materially smaller than the raw input).
    expect(row.context.length).toBeLessThan(huge.length);
  });

  it("does NOT insert any decision row with status='pending' under the malformed path", async () => {
    const reportId = await seedSupervisorReport();

    await escalateMalformedSupervisorOutput(sql, {
      hiveId: HIVE_ID,
      reportId,
      reason: "missing block",
      rawOutput: "plain text, no json",
    });

    const [{ pending }] = await sql<{ pending: number }[]>`
      SELECT COUNT(*)::int AS pending
      FROM decisions WHERE hive_id = ${HIVE_ID} AND status = 'pending'
    `;
    expect(pending).toBe(0);
  });
});
