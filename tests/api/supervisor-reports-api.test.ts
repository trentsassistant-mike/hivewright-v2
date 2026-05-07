import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "@/app/api/supervisor-reports/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_A = "aaaaaaaa-0000-0000-0000-000000000001";
const HIVE_B = "bbbbbbbb-0000-0000-0000-000000000002";

async function seedHive(id: string, slug: string): Promise<void> {
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${id}, ${slug}, ${slug}, 'digital')
  `;
}

async function insertReport(hiveId: string, ageInterval: string): Promise<string> {
  const report = {
    hiveId,
    scannedAt: new Date().toISOString(),
    findings: [],
    metrics: {
      openTasks: 0,
      activeGoals: 0,
      openDecisions: 0,
      tasksCompleted24h: 0,
      tasksFailed24h: 0,
    },
  };
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO supervisor_reports (hive_id, report, ran_at)
    VALUES (${hiveId}, ${sql.json(report)}, NOW() - ${ageInterval}::interval)
    RETURNING id
  `;
  return row.id;
}

beforeEach(async () => {
  await truncateAll(sql);
  await seedHive(HIVE_A, "hive-a");
  await seedHive(HIVE_B, "hive-b");
});

describe("GET /api/supervisor-reports", () => {
  it("returns recent reports for the requested hive, newest first", async () => {
    const oldId = await insertReport(HIVE_A, "2 hours");
    const newId = await insertReport(HIVE_A, "5 minutes");
    await insertReport(HIVE_B, "1 minute"); // different hive — must be excluded

    const res = await GET(
      new Request(`http://localhost/api/supervisor-reports?hiveId=${HIVE_A}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe(newId);
    expect(body.data[1].id).toBe(oldId);
    expect(body.data.every((r: { hiveId: string }) => r.hiveId === HIVE_A)).toBe(true);
  });

  it("honours the limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await insertReport(HIVE_A, `${i + 1} minutes`);
    }
    const res = await GET(
      new Request(`http://localhost/api/supervisor-reports?hiveId=${HIVE_A}&limit=2`),
    );
    const body = await res.json();
    expect(body.data).toHaveLength(2);
  });

  it("rejects requests missing a hiveId", async () => {
    const res = await GET(new Request("http://localhost/api/supervisor-reports"));
    expect(res.status).toBe(400);
  });

  it("rejects non-UUID hiveId values", async () => {
    const res = await GET(
      new Request("http://localhost/api/supervisor-reports?hiveId=not-a-uuid"),
    );
    expect(res.status).toBe(400);
  });

  it("caps limit at the MAX_LIMIT ceiling", async () => {
    for (let i = 0; i < 3; i++) {
      await insertReport(HIVE_A, `${i + 1} minutes`);
    }
    // Request an absurd limit — the route must cap it, not pass it to SQL.
    const res = await GET(
      new Request(`http://localhost/api/supervisor-reports?hiveId=${HIVE_A}&limit=10000`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeLessThanOrEqual(100);
    expect(body.data.length).toBe(3); // only 3 rows seeded
  });
});
