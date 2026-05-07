import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "@/app/api/brief/route";
import { testSql as sql, truncateAll } from "../../_lib/test-db";

/**
 * /api/brief must expose a `supervisor` section summarizing the latest
 * heartbeat row so the dashboard can render an at-a-glance stat without
 * a second round trip. Shape contract:
 *   supervisor: { latestReport: { id, ranAt, findings, actionsEmitted,
 *                                 actionsApplied } | null }
 */

const HIVE = "aaaaaaaa-0000-0000-0000-000000000010";
const OTHER_HIVE = "bbbbbbbb-0000-0000-0000-000000000020";

async function seedHive(id: string, slug: string): Promise<void> {
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${id}, ${slug}, ${slug}, 'digital')
  `;
}

async function briefPayload(hiveId: string): Promise<Record<string, unknown>> {
  const res = await GET(
    new Request(`http://localhost/api/brief?hiveId=${hiveId}`),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Record<string, unknown> };
  return body.data;
}

beforeEach(async () => {
  await truncateAll(sql);
  await seedHive(HIVE, "brief-hive");
  await seedHive(OTHER_HIVE, "other-hive");
});

describe("GET /api/brief — supervisor section", () => {
  it("returns supervisor.latestReport null when no reports exist", async () => {
    const data = await briefPayload(HIVE);
    expect(data).toHaveProperty("supervisor");
    const sup = data.supervisor as { latestReport: unknown };
    expect(sup.latestReport).toBeNull();
  });

  it("summarizes the most recent supervisor_reports row", async () => {
    // Older report — must NOT be the one summarized.
    await sql`
      INSERT INTO supervisor_reports (hive_id, report, actions, action_outcomes, ran_at)
      VALUES (
        ${HIVE}::uuid,
        ${sql.json({
          hiveId: HIVE,
          scannedAt: "2026-04-20T00:00:00Z",
          findings: [
            { id: "old1", kind: "stalled_task", severity: "warn", ref: {}, summary: "", detail: {} },
          ],
          metrics: {
            openTasks: 0,
            activeGoals: 0,
            openDecisions: 0,
            tasksCompleted24h: 0,
            tasksFailed24h: 0,
          },
        })},
        ${sql.json({ summary: "old", findings_addressed: [], actions: [] })},
        ${sql.json([])},
        NOW() - interval '2 hours'
      )
    `;

    // Newer report — this one should surface in the brief.
    const [newer] = await sql<{ id: string }[]>`
      INSERT INTO supervisor_reports (hive_id, report, actions, action_outcomes, cost_cents, ran_at)
      VALUES (
        ${HIVE}::uuid,
        ${sql.json({
          hiveId: HIVE,
          scannedAt: "2026-04-21T00:00:00Z",
          findings: [
            { id: "f1", kind: "unsatisfied_completion", severity: "warn", ref: {}, summary: "", detail: {} },
            { id: "f2", kind: "stalled_task", severity: "critical", ref: {}, summary: "", detail: {} },
            { id: "f3", kind: "aging_decision", severity: "info", ref: {}, summary: "", detail: {} },
          ],
          metrics: {
            openTasks: 1,
            activeGoals: 1,
            openDecisions: 1,
            tasksCompleted24h: 0,
            tasksFailed24h: 0,
          },
        })},
        ${sql.json({
          summary: "two nudges plus a decision",
          findings_addressed: ["f1", "f2", "f3"],
          actions: [
            { kind: "wake_goal", goalId: "00000000-0000-0000-0000-000000000000", reasoning: "" },
            { kind: "noop", reasoning: "logged" },
            { kind: "create_decision", tier: 2, title: "t", context: "c" },
          ],
        })},
        ${sql.json([
          { action: { kind: "wake_goal", goalId: "00000000-0000-0000-0000-000000000000", reasoning: "" }, status: "applied", detail: "" },
          { action: { kind: "noop", reasoning: "logged" }, status: "skipped", detail: "" },
          { action: { kind: "create_decision", tier: 2, title: "t", context: "c" }, status: "applied", detail: "" },
        ])},
        1234,
        NOW() - interval '5 minutes'
      )
      RETURNING id
    `;

    const data = await briefPayload(HIVE);
    const sup = data.supervisor as {
      latestReport: {
        id: string;
        ranAt: string;
        findings: number;
        actionsEmitted: number;
        actionsApplied: number;
      };
    };
    expect(sup.latestReport).not.toBeNull();
    expect(sup.latestReport.id).toBe(newer.id);
    expect(sup.latestReport.findings).toBe(3);
    expect(sup.latestReport.actionsEmitted).toBe(3);
    expect(sup.latestReport.actionsApplied).toBe(2);
    expect(typeof sup.latestReport.ranAt).toBe("string");
  });

  it("never leaks reports from a different hive", async () => {
    await sql`
      INSERT INTO supervisor_reports (hive_id, report, ran_at)
      VALUES (
        ${OTHER_HIVE}::uuid,
        ${sql.json({
          hiveId: OTHER_HIVE,
          scannedAt: "2026-04-21T00:00:00Z",
          findings: [
            { id: "x", kind: "stalled_task", severity: "warn", ref: {}, summary: "", detail: {} },
          ],
          metrics: {
            openTasks: 0,
            activeGoals: 0,
            openDecisions: 0,
            tasksCompleted24h: 0,
            tasksFailed24h: 0,
          },
        })},
        NOW()
      )
    `;

    const data = await briefPayload(HIVE);
    const sup = data.supervisor as { latestReport: unknown };
    expect(sup.latestReport).toBeNull();
  });

  it("tolerates a report with no actions / null outcomes", async () => {
    await sql`
      INSERT INTO supervisor_reports (hive_id, report, actions, action_outcomes, ran_at)
      VALUES (
        ${HIVE}::uuid,
        ${sql.json({
          hiveId: HIVE,
          scannedAt: "2026-04-21T00:00:00Z",
          findings: [],
          metrics: {
            openTasks: 0,
            activeGoals: 0,
            openDecisions: 0,
            tasksCompleted24h: 0,
            tasksFailed24h: 0,
          },
        })},
        NULL,
        NULL,
        NOW()
      )
    `;

    const data = await briefPayload(HIVE);
    const sup = data.supervisor as {
      latestReport: { findings: number; actionsEmitted: number; actionsApplied: number };
    };
    expect(sup.latestReport).not.toBeNull();
    expect(sup.latestReport.findings).toBe(0);
    expect(sup.latestReport.actionsEmitted).toBe(0);
    expect(sup.latestReport.actionsApplied).toBe(0);
  });
});
