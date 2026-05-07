import { describe, it, expect, beforeEach, vi } from "vitest";
import { GET as searchMemory } from "@/app/api/memory/search/route";
import { POST as ownerDirective } from "@/app/api/memory/hive/route";
import { POST as workIntake } from "@/app/api/work/route";
import { testSql as db, truncateAll } from "../_lib/test-db";

// Stub the classifier so these tests don't attempt real LLM calls.
// The mock mimics the old keyword-based heuristic for backwards compatibility.
vi.mock("@/work-intake/runner", () => ({
  runClassifier: vi.fn(async (_sql: unknown, input: string) => {
    const lower = input.toLowerCase();
    const goalKeywords = ["strategy", "plan", "build", "create", "develop", "design", "launch",
      "implement across", "comprehensive", "complete", "full", "entire", "all pages",
      "research and", "analyze and", "multiple", "phases"];
    const sentenceCount = input.split(/[.!?]+/).filter((s: string) => s.trim().length > 0).length;
    const hasGoalKw = goalKeywords.some((kw) => lower.includes(kw));
    const isGoal = (sentenceCount >= 3 && hasGoalKw) || (input.length > 200 && hasGoalKw);
    return {
      result: isGoal
        ? { type: "goal", confidence: 0.85, reasoning: "goal keywords detected" }
        : { type: "task", role: "dev-agent", confidence: 0.85, reasoning: "short task" },
      attempts: [],
      usedFallback: false,
      providerUsed: "ollama",
      modelUsed: "qwen3:32b",
    };
  }),
}));

const TEST_PREFIX = "p5-mem-";

let testHiveId: string;

beforeEach(async () => {
  await truncateAll(db);

  // role_templates FK required by role_memory.role_slug
  await db`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Dev Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  // Create a test hive
  const [biz] = await db`
    INSERT INTO hives (slug, name, type)
    VALUES (${TEST_PREFIX + "biz"}, ${TEST_PREFIX + "Test Hive"}, 'digital')
    RETURNING id
  `;
  testHiveId = biz.id;

  // Seed some memory entries for search tests
  await db`
    INSERT INTO hive_memory (hive_id, content, category, confidence)
    VALUES (${testHiveId}, ${TEST_PREFIX + "peak sales happen in December"}, 'seasonal', 1.0)
  `;
  await db`
    INSERT INTO role_memory (hive_id, role_slug, content, confidence)
    VALUES (${testHiveId}, 'dev-agent', ${TEST_PREFIX + "API uses OAuth2 for auth"}, 0.9)
  `;
});

describe("GET /api/memory/search", () => {
  it("finds matching entries across memory stores", async () => {
    const req = new Request(
      `http://localhost:3000/api/memory/search?hiveId=${testHiveId}&q=${encodeURIComponent(TEST_PREFIX)}&limit=20`,
    );
    const res = await searchMemory(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeInstanceOf(Array);
    expect(body.data.length).toBeGreaterThanOrEqual(2);

    const stores = body.data.map((e: { store: string }) => e.store);
    expect(stores).toContain("hive_memory");
    expect(stores).toContain("role_memory");

    const found = body.data.find((e: { content: string }) =>
      e.content.includes("peak sales happen in December"),
    );
    expect(found).toBeDefined();
    expect(found.store).toBe("hive_memory");
  });

  it("returns 400 when hiveId is missing", async () => {
    const req = new Request("http://localhost:3000/api/memory/search?q=oauth");
    const res = await searchMemory(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/hiveId/i);
  });
});

describe("POST /api/memory/hive", () => {
  it("inserts owner directive with confidence 1.0 and returns 201", async () => {
    const req = new Request("http://localhost:3000/api/memory/hive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: testHiveId,
        content: TEST_PREFIX + "never discount below 20%",
        category: "pricing",
      }),
    });
    const res = await ownerDirective(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeDefined();
    expect(body.data.confidence).toBe(1);
    expect(body.data.content).toBe(TEST_PREFIX + "never discount below 20%");

    // Verify it's actually in the DB
    const [row] = await db`
      SELECT * FROM hive_memory WHERE content = ${TEST_PREFIX + "never discount below 20%"}
    `;
    expect(row).toBeDefined();
    expect(row.confidence).toBe(1);
    expect(row.category).toBe("pricing");
  });

  it("returns 400 when required fields are missing", async () => {
    const req = new Request("http://localhost:3000/api/memory/hive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: testHiveId }),
    });
    const res = await ownerDirective(req);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/work", () => {
  it("creates a task for a simple short input", async () => {
    const req = new Request("http://localhost:3000/api/work", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: testHiveId,
        input: TEST_PREFIX + "Fix the login button bug",
      }),
    });
    const res = await workIntake(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.type).toBe("task");
    expect(body.data.id).toBeDefined();
    expect(body.data.title).toBeDefined();

    // Verify in DB
    const [row] = await db`SELECT * FROM tasks WHERE id = ${body.data.id}`;
    expect(row).toBeDefined();
    expect(row.assigned_to).toBe("dev-agent");
  });

  it("creates a goal for a complex multi-sentence input with goal keywords", async () => {
    const complexInput =
      TEST_PREFIX +
      "Build a comprehensive e-commerce platform for our hive. " +
      "Design the full checkout flow with multiple payment providers. " +
      "Develop and launch the entire storefront including all pages.";

    const req = new Request("http://localhost:3000/api/work", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: testHiveId,
        input: complexInput,
      }),
    });
    const res = await workIntake(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.type).toBe("goal");
    expect(body.data.id).toBeDefined();
    expect(body.data.title).toBeDefined();

    // Verify in DB
    const [row] = await db`SELECT * FROM goals WHERE id = ${body.data.id}`;
    expect(row).toBeDefined();
    expect(row.hive_id).toBe(testHiveId);
  });

  it("returns 400 when required fields are missing", async () => {
    const req = new Request("http://localhost:3000/api/work", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: testHiveId }),
    });
    const res = await workIntake(req);
    expect(res.status).toBe(400);
  });
});
