import { describe, it, expect, beforeEach } from "vitest";
import { createBriefGetHandler } from "@/app/api/brief/get-handler";
import { testSql as sql, truncateAll } from "../../_lib/test-db";

const HIVE = "aaaaaaaa-0000-0000-0000-000000000333";

async function seedHive(id: string, slug: string): Promise<void> {
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${id}, ${slug}, ${slug}, 'digital')
  `;
}

beforeEach(async () => {
  await truncateAll(sql);
  await seedHive(HIVE, "brief-initiative");
});

describe("GET /api/brief — initiative section", () => {
  it("returns latest initiative run plus aggregated 7d summary", async () => {
    const GET = createBriefGetHandler(sql);

    await sql`
      INSERT INTO initiative_runs (
        hive_id, trigger_type, status, started_at, completed_at,
        evaluated_candidates, created_count, created_goals, created_tasks,
        created_decisions, suppressed_count, noop_count, suppression_reasons,
        run_failures, failure_reason
      ) VALUES (
        ${HIVE}::uuid,
        'ideas-backlog',
        'completed',
        NOW() - interval '20 minutes',
        NOW() - interval '19 minutes',
        6,
        2,
        1,
        1,
        0,
        4,
        0,
        ${sql.json({ duplicate_goal: 2, low_signal: 2 })},
        0,
        NULL
      ), (
        ${HIVE}::uuid,
        'failure-followups',
        'failed',
        NOW() - interval '2 days',
        NOW() - interval '2 days' + interval '3 minutes',
        3,
        0,
        0,
        0,
        0,
        3,
        0,
        ${sql.json({ muted_role: 3 })},
        1,
        'dispatcher unavailable'
      )
    `;

    const res = await GET(new Request(`http://localhost/api/brief?hiveId=${HIVE}`));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.initiative.last7d).toMatchObject({
      windowHours: 168,
      runCount: 2,
      completedRuns: 1,
      failedRuns: 1,
      evaluatedCandidates: 9,
      createdItems: 2,
      suppressedItems: 7,
      runFailures: 1,
    });
    expect(body.data.initiative.latestRun).toMatchObject({
      trigger: "ideas-backlog",
      status: "completed",
      evaluatedCandidates: 6,
      createdCount: 2,
      suppressedCount: 4,
      runFailures: 0,
    });
    expect(body.data.initiative.latestRun.topSuppressionReasons).toEqual([
      { reason: "duplicate_goal", count: 2 },
      { reason: "low_signal", count: 2 },
    ]);
  });
});
