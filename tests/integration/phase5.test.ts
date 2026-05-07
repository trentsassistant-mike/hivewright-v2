import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { syncRoleLibrary } from "@/roles/sync";
import { GET as getHives } from "@/app/api/hives/route";
import { POST as createTask } from "@/app/api/tasks/route";
import { GET as getTaskById } from "@/app/api/tasks/[id]/route";
import { POST as createGoal } from "@/app/api/goals/route";
import { GET as getGoalById } from "@/app/api/goals/[id]/route";
import { GET as getDecisions } from "@/app/api/decisions/route";
import { POST as respondDecision } from "@/app/api/decisions/[id]/respond/route";
import { GET as searchMemory } from "@/app/api/memory/search/route";
import { POST as postDirective } from "@/app/api/memory/hive/route";
import { POST as postWork } from "@/app/api/work/route";
import { emitTaskEvent } from "@/dispatcher/event-emitter";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const BASE = "http://localhost:3000";
let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);

  // Sync role library so FK constraints on assigned_to are satisfied
  await syncRoleLibrary(path.resolve(__dirname, "../../role-library"), sql);

  // Create test hive
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('p5-integ', 'P5 Integration', 'digital')
    RETURNING *
  `;
  bizId = biz.id;
});

describe("Phase 5 Integration: Interfaces", () => {
  it("hives API returns the test hive", async () => {
    const res = await getHives();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    const found = body.data.find((b: { slug: string }) => b.slug === "p5-integ");
    expect(found).toBeDefined();
    expect(found.name).toBe("P5 Integration");
  });

  it("creates and retrieves a task via API", async () => {
    // POST to create
    const createReq = new Request(`${BASE}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: bizId,
        assignedTo: "dev-agent",
        title: "p5-int-task-one",
        brief: "Write a brief for integration testing",
        priority: 3,
      }),
    });

    const createRes = await createTask(createReq);
    expect(createRes.status).toBe(201);

    const createBody = await createRes.json();
    const created = createBody.data;
    expect(created.title).toBe("p5-int-task-one");
    expect(created.id).toBeDefined();
    const taskId: string = created.id;

    // GET by ID
    const getReq = new Request(`${BASE}/api/tasks/${taskId}`);
    const getRes = await getTaskById(getReq, {
      params: Promise.resolve({ id: taskId }),
    });
    expect(getRes.status).toBe(200);

    const fetchBody = await getRes.json();
    const fetched = fetchBody.data;
    expect(fetched.id).toBe(taskId);
    expect(fetched.title).toBe("p5-int-task-one");
  });

  it("creates and retrieves a goal via API", async () => {
    // POST to create
    const createReq = new Request(`${BASE}/api/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: bizId,
        title: "p5-int-goal-one",
        description: "End-to-end goal for Phase 5 integration test",
      }),
    });

    const createRes = await createGoal(createReq);
    expect(createRes.status).toBe(201);

    const createBody = await createRes.json();
    const created = createBody.data;
    expect(created.title).toBe("p5-int-goal-one");
    expect(created.id).toBeDefined();
    const goalId: string = created.id;

    // GET by ID — should include taskSummary
    const getReq = new Request(`${BASE}/api/goals/${goalId}`);
    const getRes = await getGoalById(getReq, {
      params: Promise.resolve({ id: goalId }),
    });
    expect(getRes.status).toBe(200);

    const fetchBody = await getRes.json();
    const fetched = fetchBody.data;
    expect(fetched.id).toBe(goalId);
    expect(fetched.title).toBe("p5-int-goal-one");
    expect(fetched.taskSummary).toBeDefined();
  });

  it("decision respond flow works", async () => {
    // Insert a decision directly via SQL
    const [decision] = await sql`
      INSERT INTO decisions (hive_id, title, context, priority)
      VALUES (${bizId}, 'p5-int-decision-one', 'Should we invest?', 'normal')
      RETURNING *
    `;
    const decisionId: string = decision.id;

    // Verify it shows up in GET decisions
    const listReq = new Request(
      `${BASE}/api/decisions?hiveId=${bizId}&status=pending`,
    );
    const listRes = await getDecisions(listReq);
    expect(listRes.status).toBe(200);

    const listBody = await listRes.json();
    const found = listBody.data.find(
      (d: { id: string }) => d.id === decisionId,
    );
    expect(found).toBeDefined();
    expect(found.status).toBe("pending");

    // POST respond: approve the decision
    const respondReq = new Request(
      `${BASE}/api/decisions/${decisionId}/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "approved", comment: "looks good" }),
      },
    );
    const respondRes = await respondDecision(respondReq, {
      params: Promise.resolve({ id: decisionId }),
    });
    expect(respondRes.status).toBe(200);

    const respondBody = await respondRes.json();
    const updated = respondBody.data;
    expect(updated.status).toBe("resolved");
    expect(updated.ownerResponse).toContain("approved");

    // Confirm in DB
    const [row] = await sql`SELECT status FROM decisions WHERE id = ${decisionId}`;
    expect(row.status).toBe("resolved");
  });

  it("owner directive inserts into hive memory", async () => {
    const content = "p5-int-directive: always use TypeScript strict mode";

    // POST directive
    const postReq = new Request(`${BASE}/api/memory/hive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: bizId, content, category: "directives" }),
    });
    const postRes = await postDirective(postReq);
    expect(postRes.status).toBe(201);

    const insertBody = await postRes.json();
    const inserted = insertBody.data;
    expect(inserted.content).toBe(content);

    // Search memory and verify it's found
    const searchReq = new Request(
      `${BASE}/api/memory/search?hiveId=${bizId}&q=p5-int-directive`,
    );
    const searchRes = await searchMemory(searchReq);
    expect(searchRes.status).toBe(200);

    const searchBody = await searchRes.json();
    const results = searchBody.data;
    expect(Array.isArray(results)).toBe(true);
    const match = results.find((r: { content: string }) =>
      r.content.includes("p5-int-directive"),
    );
    expect(match).toBeDefined();
  });

  it("unified work intake creates task for simple input", async () => {
    const req = new Request(`${BASE}/api/work`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: bizId,
        input: "p5-int-write the weekly newsletter",
        assignedTo: "dev-agent",
      }),
    });

    const res = await postWork(req);
    expect(res.status).toBe(201);

    const resBody = await res.json();
    const body = resBody.data;
    expect(body.type).toBe("task");
    expect(body.id).toBeDefined();
    expect(body.title).toContain("p5-int-write the weekly newsletter");
  });

  it("event emitter sends NOTIFY", async () => {
    // Listen on the task_events channel using a separate connection
    const { default: postgres } = await import("postgres");
    const listenerSql = postgres(
      process.env.TEST_DATABASE_URL ??
        process.env.DATABASE_URL ??
        "postgresql://hivewright:hivewright@localhost:5432/hivewright_test",
    );

    let received: string | null = null;
    try {
      await listenerSql.listen("task_events", (msg) => {
        received = msg;
      });

      // Emit an event
      await emitTaskEvent(sql, {
        type: "task_created",
        taskId: "00000000-0000-0000-0000-000000000099",
        title: "p5-int-event-test",
        assignedTo: "dev-agent",
        hiveId: bizId,
      });

      // Give the notification a moment to arrive
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await listenerSql.end();
    }

    expect(received).not.toBeNull();
    const parsed = JSON.parse(received as unknown as string);
    expect(parsed.type).toBe("task_created");
    expect(parsed.title).toBe("p5-int-event-test");
    expect(parsed.timestamp).toBeDefined();
  });
});
