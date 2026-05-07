import { describe, it, expect, beforeEach } from "vitest";
import { GET as getTimeline } from "@/app/api/memory/timeline/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const PREFIX = "p6-tl-";
let hiveId: string;
let taskId: string;

beforeEach(async () => {
  await truncateAll(sql);

  // role_templates FK required by role_memory.role_slug
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Dev Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  // Create a test hive
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES (${PREFIX + "biz"}, ${PREFIX + "Test Hive"}, 'digital')
    RETURNING id
  `;
  hiveId = biz.id;

  // Create a test task (for source_task_id FKs)
  const [task] = await sql`
    INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
    VALUES (${hiveId}, 'dev-agent', 'test', ${PREFIX + "task"}, 'test brief')
    RETURNING id
  `;
  taskId = task.id;

  // Seed role_memory entries — oldest first so we can verify DESC ordering
  await sql`
    INSERT INTO role_memory (hive_id, role_slug, content, confidence, source_task_id, created_at)
    VALUES (${hiveId}, 'dev-agent', ${PREFIX + "API uses REST not GraphQL"}, 0.9, ${taskId},
            NOW() - INTERVAL '3 days')
  `;
  await sql`
    INSERT INTO role_memory (hive_id, role_slug, content, confidence, created_at)
    VALUES (${hiveId}, 'dev-agent', ${PREFIX + "superseded entry"}, 0.5,
            NOW() - INTERVAL '5 days')
  `;
  // Supersede the second entry
  const [superseded] = await sql`
    SELECT id FROM role_memory WHERE content = ${PREFIX + "superseded entry"}
  `;
  await sql`
    UPDATE role_memory
    SET superseded_by = ${superseded.id}
    WHERE content = ${PREFIX + "superseded entry"}
  `;

  // Seed hive_memory entries
  await sql`
    INSERT INTO hive_memory (hive_id, category, content, confidence, source_task_id, created_at)
    VALUES (${hiveId}, 'pricing', ${PREFIX + "peak sales in December"}, 1.0, ${taskId},
            NOW() - INTERVAL '1 day')
  `;
  await sql`
    INSERT INTO hive_memory (hive_id, category, content, confidence, created_at)
    VALUES (${hiveId}, 'operations', ${PREFIX + "warehouse open Mon-Fri"}, 0.8,
            NOW() - INTERVAL '2 days')
  `;

  // Seed insights entries
  await sql`
    INSERT INTO insights (hive_id, content, connection_type, confidence, max_source_sensitivity, created_at)
    VALUES (${hiveId}, ${PREFIX + "cross-dept synergy detected"}, 'cross_department', 0.7, 'internal',
            NOW() - INTERVAL '4 hours')
  `;
});

describe("GET /api/memory/timeline", () => {
  it("returns entries from all three stores", async () => {
    const req = new Request(
      `http://localhost:3000/api/memory/timeline?hiveId=${hiveId}`,
    );
    const res = await getTimeline(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeInstanceOf(Array);

    const stores = new Set(body.data.map((e: { store: string }) => e.store));
    expect(stores.has("role_memory")).toBe(true);
    expect(stores.has("hive_memory")).toBe(true);
    expect(stores.has("insights")).toBe(true);
  });

  it("excludes superseded entries", async () => {
    const req = new Request(
      `http://localhost:3000/api/memory/timeline?hiveId=${hiveId}`,
    );
    const res = await getTimeline(req);
    const body = await res.json();

    const supersededEntry = body.data.find(
      (e: { content: string }) => e.content === PREFIX + "superseded entry",
    );
    expect(supersededEntry).toBeUndefined();
  });

  it("entries are ordered by created_at DESC", async () => {
    const req = new Request(
      `http://localhost:3000/api/memory/timeline?hiveId=${hiveId}`,
    );
    const res = await getTimeline(req);
    const body = await res.json();

    const dates = body.data.map((e: { created_at: string }) =>
      new Date(e.created_at).getTime(),
    );
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });

  it("supports limit and offset", async () => {
    const req = new Request(
      `http://localhost:3000/api/memory/timeline?hiveId=${hiveId}&limit=2&offset=0`,
    );
    const res = await getTimeline(req);
    const body = await res.json();
    expect(body.data.length).toBeLessThanOrEqual(2);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);

    // Fetch next page
    const req2 = new Request(
      `http://localhost:3000/api/memory/timeline?hiveId=${hiveId}&limit=2&offset=2`,
    );
    const res2 = await getTimeline(req2);
    const body2 = await res2.json();
    expect(body2.offset).toBe(2);

    // Entries should not overlap
    const ids1 = new Set(body.data.map((e: { id: string }) => e.id));
    const overlap = body2.data.filter((e: { id: string }) => ids1.has(e.id));
    expect(overlap.length).toBe(0);
  });

  it("requires hiveId", async () => {
    const req = new Request("http://localhost:3000/api/memory/timeline");
    const res = await getTimeline(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/hiveId/i);
  });

  it("filters by store when store param is provided", async () => {
    const req = new Request(
      `http://localhost:3000/api/memory/timeline?hiveId=${hiveId}&store=role_memory`,
    );
    const res = await getTimeline(req);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);

    const stores = new Set(body.data.map((e: { store: string }) => e.store));
    expect(stores.size).toBe(1);
    expect(stores.has("role_memory")).toBe(true);
  });

  it("includes store-specific columns", async () => {
    const req = new Request(
      `http://localhost:3000/api/memory/timeline?hiveId=${hiveId}`,
    );
    const res = await getTimeline(req);
    const body = await res.json();

    const roleEntry = body.data.find(
      (e: { store: string }) => e.store === "role_memory",
    );
    expect(roleEntry).toBeDefined();
    expect(roleEntry.role_slug).toBe("dev-agent");
    expect(roleEntry.source_task_id).toBe(taskId);

    const bizEntry = body.data.find(
      (e: { store: string }) => e.store === "hive_memory",
    );
    expect(bizEntry).toBeDefined();
    expect(bizEntry.category).toBeDefined();
    expect(bizEntry.source_task_id).toBeDefined();

    const insightEntry = body.data.find(
      (e: { store: string }) => e.store === "insights",
    );
    expect(insightEntry).toBeDefined();
    expect(insightEntry.connection_type).toBe("cross_department");
  });
});
