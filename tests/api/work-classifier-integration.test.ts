import { describe, it, expect, beforeEach, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

// Stub the classifier runner BEFORE importing the route. The stub allows each
// test to inject the ClassifierOutcome the route should see.
let stubOutcome: unknown = null;
vi.mock("@/work-intake/runner", () => ({
  runClassifier: vi.fn(async () => stubOutcome),
}));

// Dynamic import so the vi.mock above is registered first.
let POST: typeof import("@/app/api/work/route").POST;

let bizId: string;
let otherBizId: string;

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO role_templates (slug, name, department, type, adapter_type, active)
    VALUES
      ('dev-agent', 'Dev', 'engineering', 'executor', 'claude-code', true),
      ('data-analyst', 'Data', 'research', 'executor', 'claude-code', true)
    ON CONFLICT (slug) DO NOTHING
  `;
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type) VALUES ('wci-biz', 'WCI', 'digital')
    RETURNING id
  `;
  bizId = biz.id;
  const [otherBiz] = await sql`
    INSERT INTO hives (slug, name, type) VALUES ('wci-other-biz', 'WCI Other', 'digital')
    RETURNING id
  `;
  otherBizId = otherBiz.id;

  ({ POST } = await import("@/app/api/work/route"));
});

function req(body: Record<string, unknown>) {
  return new Request("http://localhost:3000/api/work", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/work with classifier", () => {
  it("creates a task with the classifier-chosen role", async () => {
    stubOutcome = {
      result: { type: "task", role: "data-analyst", confidence: 0.9, reasoning: "diagnostic query" },
      attempts: [{
        provider: "ollama", model: "qwen3:32b",
        prompt: "p", input: "Why did the dispatcher restart?",
        responseRaw: '{"type":"task",...}',
        tokensIn: 100, tokensOut: 20, costCents: 0,
        latencyMs: 300, success: true, errorReason: null,
      }],
      usedFallback: false, providerUsed: "ollama", modelUsed: "qwen3:32b",
    };

    const res = await POST(req({ hiveId: bizId, input: "Why did the dispatcher restart?" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.type).toBe("task");
    const taskId = body.data.id as string;

    const [task] = await sql`SELECT assigned_to FROM tasks WHERE id = ${taskId}`;
    expect(task.assigned_to).toBe("data-analyst");

    const [cls] = await sql`SELECT * FROM classifications WHERE task_id = ${taskId}`;
    expect(cls.type).toBe("task");
    expect(cls.assigned_role).toBe("data-analyst");
    expect(Number(cls.confidence)).toBeCloseTo(0.9);
    expect(cls.provider).toBe("ollama");

    const logs = await sql`SELECT * FROM classifier_logs WHERE classification_id = ${cls.id}`;
    expect(logs).toHaveLength(1);
  });

  it("creates a goal when classifier returns type=goal", async () => {
    stubOutcome = {
      result: { type: "goal", confidence: 0.92, reasoning: "big scope" },
      attempts: [{
        provider: "ollama", model: "qwen3:32b",
        prompt: "p", input: "Launch a product",
        responseRaw: "", tokensIn: 50, tokensOut: 15, costCents: 0,
        latencyMs: 200, success: true, errorReason: null,
      }],
      usedFallback: false, providerUsed: "ollama", modelUsed: "qwen3:32b",
    };

    const res = await POST(req({ hiveId: bizId, input: "Launch a product" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.type).toBe("goal");
    const goalId = body.data.id as string;

    const [cls] = await sql`SELECT * FROM classifications WHERE goal_id = ${goalId}`;
    expect(cls.type).toBe("goal");
    expect(cls.assigned_role).toBeNull();
  });

  it("defaults to goal when classifier returns null", async () => {
    stubOutcome = {
      result: null,
      attempts: [
        { provider: "ollama", model: "qwen3:32b", prompt: "p", input: "x",
          responseRaw: null, tokensIn: null, tokensOut: null, costCents: null,
          latencyMs: 50, success: false, errorReason: "network" },
        { provider: "openrouter", model: "g", prompt: "p", input: "x",
          responseRaw: null, tokensIn: null, tokensOut: null, costCents: null,
          latencyMs: 80, success: false, errorReason: "401" },
      ],
      usedFallback: true, providerUsed: "default-goal-fallback", modelUsed: null,
    };

    const res = await POST(req({ hiveId: bizId, input: "x" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.type).toBe("goal");
    const goalId = body.data.id as string;

    const [goal] = await sql`SELECT description FROM goals WHERE id = ${goalId}`;
    expect(goal.description).toContain("could not produce a confident classification");

    const logs = await sql`SELECT * FROM classifier_logs ORDER BY created_at`;
    expect(logs).toHaveLength(2);
    expect(logs[0].success).toBe(false);
    expect(logs[1].success).toBe(false);
  });

  it("explicit assignedTo bypasses classifier", async () => {
    stubOutcome = { result: { type: "goal", confidence: 0.9, reasoning: "x" }, attempts: [], usedFallback: false, providerUsed: "ollama", modelUsed: "m" };
    const res = await POST(req({ hiveId: bizId, input: "whatever", assignedTo: "dev-agent" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.type).toBe("task");
    const rows = await sql`SELECT count(*)::int AS n FROM classifications`;
    expect(rows[0].n).toBe(0);
  });

  it("rejects a goalId from another hive", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status)
      VALUES (${otherBizId}, 'Other hive goal', 'active')
      RETURNING id
    `;

    const res = await POST(req({
      hiveId: bizId,
      goalId: goal.id,
      input: "Cross-hive goal reference",
      assignedTo: "dev-agent",
    }));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "Forbidden: goal does not belong to hive",
    });
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM tasks`;
    expect(n).toBe(0);
  });

  it("rejects a projectId from another hive", async () => {
    const [project] = await sql`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES (${otherBizId}, 'other-project', 'Other Project', '/tmp/other-project')
      RETURNING id
    `;

    const res = await POST(req({
      hiveId: bizId,
      projectId: project.id,
      input: "Cross-hive project reference",
      assignedTo: "dev-agent",
    }));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: "Forbidden: project does not belong to hive",
    });
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM tasks`;
    expect(n).toBe(0);
  });

  it("leaves projectId null when projectId is omitted with one project", async () => {
    await sql`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES (${bizId}, 'hivewrightv2', 'HiveWright v2', ${process.cwd()})
    `;

    const res = await POST(req({
      hiveId: bizId,
      input: "Fix the onboarding copy",
      assignedTo: "dev-agent",
    }));

    expect(res.status).toBe(201);
    const body = await res.json();
    const [task] = await sql`
      SELECT project_id FROM tasks WHERE id = ${body.data.id}
    `;
    expect(task.project_id).toBeNull();
  });

  it("inherits the goal project for task intake when projectId is omitted", async () => {
    const [project] = await sql`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES (${bizId}, 'goal-project', 'Goal Project', '/tmp/work-goal-project')
      RETURNING id
    `;
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, project_id)
      VALUES (${bizId}, 'Goal with project', ${project.id})
      RETURNING id
    `;

    const res = await POST(req({
      hiveId: bizId,
      goalId: goal.id,
      input: "Fix the onboarding copy",
      assignedTo: "dev-agent",
    }));

    expect(res.status).toBe(201);
    const body = await res.json();
    const [task] = await sql`
      SELECT project_id FROM tasks WHERE id = ${body.data.id}
    `;
    expect(task.project_id).toBe(project.id);
  });

  it("leaves projectId null when the hive has no projects", async () => {
    const res = await POST(req({
      hiveId: bizId,
      input: "Fix the onboarding copy",
      assignedTo: "dev-agent",
    }));

    expect(res.status).toBe(201);
    const body = await res.json();
    const [task] = await sql`
      SELECT project_id FROM tasks WHERE id = ${body.data.id}
    `;
    expect(task.project_id).toBeNull();
  });

  it("leaves projectId null when projectId is omitted for a multi-project hive", async () => {
    await sql`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES
        (${bizId}, 'project-a', 'Project A', '/tmp/project-a'),
        (${bizId}, 'project-b', 'Project B', '/tmp/project-b')
    `;

    const res = await POST(req({
      hiveId: bizId,
      input: "Fix the onboarding copy",
      assignedTo: "dev-agent",
    }));

    expect(res.status).toBe(201);
    const body = await res.json();
    const [task] = await sql`
      SELECT project_id FROM tasks WHERE id = ${body.data.id}
    `;
    expect(task.project_id).toBeNull();
  });
});
