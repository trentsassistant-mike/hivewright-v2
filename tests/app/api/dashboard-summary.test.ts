import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  acquireSuiteIsolation,
  createFixtureNamespace,
  type FixtureNamespace,
  type TestDbIsolationLease,
  testSql as sql,
  truncateAll,
} from "../../_lib/test-db";
import { GET } from "../../../src/app/api/dashboard/summary/route";

let fixture: FixtureNamespace;
let bizHiveId: string;
let execOneSlug: string;
let execTwoSlug: string;
let sysRoleSlug: string;
let isolationLease: TestDbIsolationLease;

async function seed() {
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${bizHiveId}, ${fixture.slug("summary-biz")}, 'Summary Biz', 'digital')
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES (${execOneSlug}, 'Executor One', 'executor', 'claude-code'),
           (${execTwoSlug}, 'Executor Two', 'executor', 'claude-code'),
           (${sysRoleSlug}, 'System Role', 'system',   'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  await sql`
    INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, cost_cents, started_at)
    VALUES
      (${bizHiveId}, ${execOneSlug}, 'owner', 'active', 'A', 'a', 100, NOW()),
      (${bizHiveId}, ${execOneSlug}, 'owner', 'active', 'B', 'b', NULL, NOW()),
      (${bizHiveId}, ${execOneSlug}, 'owner', 'completed',   'C', 'c', 250, NOW()),
      (${bizHiveId}, ${execOneSlug}, 'owner', 'completed',   'D', 'd', 50,  '2020-01-01T00:00:00Z')
  `;
  await sql`
    INSERT INTO decisions (hive_id, priority, status, title, context)
    VALUES
      (${bizHiveId}, 'normal', 'pending',  'Need input',  'ctx'),
      (${bizHiveId}, 'normal', 'resolved', 'Done',        'ctx')
  `;
}

describe("GET /api/dashboard/summary", () => {
  beforeAll(async () => {
    isolationLease = await acquireSuiteIsolation(sql);
  });

  beforeEach(async () => {
    fixture = createFixtureNamespace("dashboard-summary");
    bizHiveId = fixture.uuid("biz");
    execOneSlug = fixture.slug("exec-one");
    execTwoSlug = fixture.slug("exec-two");
    sysRoleSlug = fixture.slug("sys-role");
    await truncateAll(sql, { preserveReadOnlyTables: false });
    await seed();
  });

  afterAll(async () => {
    await isolationLease.release();
  });

  it("returns counts + month spend for the hive", async () => {
    const req = new Request(`http://localhost/api/dashboard/summary?hiveId=${bizHiveId}`);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agentsEnabled: number;
      tasksInProgress: number;
      monthSpendCents: number;
      pendingApprovals: number;
    };
    expect(body.agentsEnabled).toBe(2);
    expect(body.tasksInProgress).toBe(2);
    // Only the NOW-dated completed task counts; the 2020 one is outside the current month.
    expect(body.monthSpendCents).toBe(350);
    expect(body.pendingApprovals).toBe(1);
  });

  it("returns 400 when hiveId is missing", async () => {
    const res = await GET(new Request("http://localhost/api/dashboard/summary"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when hiveId is not a valid UUID", async () => {
    const res = await GET(new Request("http://localhost/api/dashboard/summary?hiveId=not-a-uuid"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("UUID");
  });
});
