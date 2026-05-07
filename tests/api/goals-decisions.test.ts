import { describe, it, expect, beforeEach } from "vitest";
import { GET as getGoals, POST as postGoal } from "@/app/api/goals/route";
import { GET as getGoalDetail } from "@/app/api/goals/[id]/route";
import { GET as getDecisions, POST as postDecision } from "@/app/api/decisions/route";
import { PATCH as patchDecision } from "@/app/api/decisions/[id]/route";
import { POST as respondToDecision } from "@/app/api/decisions/[id]/respond/route";
import { GET as getSchedules, PATCH as patchSchedule, POST as postSchedule } from "@/app/api/schedules/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const PREFIX = "p5-gd-";
let hiveId: string;
let goalId: string;
let decisionId: string;
let taskId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES (${PREFIX + "biz"}, 'P5 GD Test Hive', 'digital')
    RETURNING id
  `;
  hiveId = biz.id;

  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, description, budget_cents)
    VALUES (${hiveId}, 'Launch new product line', 'Expand into widget category', 500000)
    RETURNING id
  `;
  goalId = goal.id;

  const [dec] = await sql`
    INSERT INTO decisions (hive_id, goal_id, title, context, recommendation, priority, status)
    VALUES (
      ${hiveId},
      ${goalId},
      'Choose widget supplier',
      'We need to pick between three suppliers for widget parts.',
      'Go with SupplierA for cost efficiency.',
      'urgent',
      'pending'
    )
    RETURNING id
  `;
  decisionId = dec.id;

  const [task] = await sql`
    INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
    VALUES (${hiveId}, 'dev-agent', 'owner', 'Test task for decision', 'Do something')
    RETURNING id
  `;
  taskId = task.id;
});

describe("Goals API", () => {
  it("POST /api/goals — creates a goal", async () => {
    const req = new Request("http://localhost/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        title: "Launch second product line",
        description: "Expand into widget category",
        budgetCents: 500000,
      }),
    });

    const res = await postGoal(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.title).toBe("Launch second product line");
    expect(body.data.hiveId).toBe(hiveId);
    expect(body.data.status).toBe("active");
    expect(body.data.budgetCents).toBe(500000);
  });

  it("POST /api/goals — auto-assigns the only project when projectId is omitted", async () => {
    const [project] = await sql`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES (${hiveId}, 'goal-project', 'Goal Project', '/tmp/goal-project')
      RETURNING id
    `;
    const req = new Request("http://localhost/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        title: "Launch with default project",
      }),
    });

    const res = await postGoal(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.projectId).toBe(project.id);
  });

  it("POST /api/goals — returns 400 when projectId is omitted for a multi-project hive", async () => {
    await sql`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES
        (${hiveId}, 'goal-project-a', 'Goal Project A', '/tmp/goal-project-a'),
        (${hiveId}, 'goal-project-b', 'Goal Project B', '/tmp/goal-project-b')
    `;
    const req = new Request("http://localhost/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        title: "Launch with ambiguous project",
      }),
    });

    const res = await postGoal(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/multiple projects; specify project_id/i);
  });

  it("POST /api/goals — returns 400 for missing fields", async () => {
    const req = new Request("http://localhost/api/goals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "No hive" }),
    });

    const res = await postGoal(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing required fields/i);
  });

  it("GET /api/goals — lists goals filtered by hiveId", async () => {
    const req = new Request(
      `http://localhost/api/goals?hiveId=${hiveId}`,
    );

    const res = await getGoals(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.total).toBeGreaterThanOrEqual(1);
    const goal = body.data.find((g: { id: string }) => g.id === goalId);
    expect(goal).toBeDefined();
    expect(goal.title).toBe("Launch new product line");
  });

  it("GET /api/goals — filters by status", async () => {
    const req = new Request(
      `http://localhost/api/goals?hiveId=${hiveId}&status=active`,
    );

    const res = await getGoals(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.every((g: { status: string }) => g.status === "active")).toBe(true);
  });

  it("GET /api/goals/[id] — returns goal detail with taskSummary and subGoals", async () => {
    const req = new Request(`http://localhost/api/goals/${goalId}`);
    const res = await getGoalDetail(req, {
      params: Promise.resolve({ id: goalId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(goalId);
    expect(body.data.title).toBe("Launch new product line");
    expect(body.data.taskSummary).toBeDefined();
    expect(typeof body.data.taskSummary).toBe("object");
    expect(Array.isArray(body.data.subGoals)).toBe(true);
  });

  it("GET /api/goals/[id] — returns 404 for unknown id", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const req = new Request(`http://localhost/api/goals/${fakeId}`);
    const res = await getGoalDetail(req, {
      params: Promise.resolve({ id: fakeId }),
    });

    expect(res.status).toBe(404);
  });

  it("GET /api/goals/[id] — includes subGoals when parent_id matches", async () => {
    // Create a sub-goal
    const [sub] = await sql`
      INSERT INTO goals (hive_id, parent_id, title)
      VALUES (${hiveId}, ${goalId}, 'Sub-goal: Phase 1')
      RETURNING id
    `;

    const req = new Request(`http://localhost/api/goals/${goalId}`);
    const res = await getGoalDetail(req, {
      params: Promise.resolve({ id: goalId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.subGoals.length).toBeGreaterThanOrEqual(1);
    const found = body.data.subGoals.find((s: { id: string }) => s.id === sub.id);
    expect(found).toBeDefined();
    expect(found.title).toBe("Sub-goal: Phase 1");
  });
});

describe("Decisions API", () => {
  async function createReleaseScanModelDecision() {
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (
        hive_id, goal_id, title, context, recommendation, options,
        priority, status, kind
      ) VALUES (
        ${hiveId},
        ${goalId},
        'Approve GPT-5.5 model registry proposal',
        'Release scan found a new OpenAI model and verified pricing.',
        'Approve to queue a dev-agent patch task for the model registry.',
        ${sql.json({
          kind: "release_scan_model_proposal",
          modelProposal: {
            source: "release-scan",
            provider: "openai",
            modelId: "openai/gpt-5.5",
            internalModelId: "openai-codex/gpt-5.5",
            inputPer1k: 0.00125,
            outputPer1k: 0.01,
            pricingSourceUrls: [
              "https://openai.com/api/pricing/",
              "https://developers.openai.com/api/docs/pricing",
            ],
          },
        })},
        'urgent',
        'pending',
        'release_scan_model_proposal'
      )
      RETURNING id
    `;
    return decision.id;
  }

  async function createDirectTaskQaCapDecision() {
    const [task] = await sql<{ id: string }[]>`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, status,
        retry_count, failure_reason, qa_required
      ) VALUES (
        ${hiveId},
        'dev-agent',
        'owner',
        'Direct task QA cap',
        'Original direct-task brief',
        'blocked',
        2,
        'QA retry cap reached (2 rework cycles). Awaiting owner recovery decision.',
        true
      )
      RETURNING id
    `;

    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (
        hive_id, task_id, title, context, recommendation, options,
        priority, status, kind
      ) VALUES (
        ${hiveId},
        ${task.id},
        'Task "Direct task QA cap" failed QA twice, what next?',
        'Direct task failed QA twice.',
        'Choose how to recover this direct task.',
        ${sql.json({
          kind: "direct_task_qa_cap_recovery",
          suggestedOption: "refine_brief_and_retry",
          taskId: task.id,
          options: [
            { label: "Retry with a different role", action: "retry_with_different_role" },
            { label: "Refine the brief and retry", action: "refine_brief_and_retry" },
            { label: "Abandon this task", action: "abandon" },
          ],
        })},
        'urgent',
        'pending',
        'decision'
      )
      RETURNING id
    `;

    return { decisionId: decision.id, taskId: task.id };
  }

  it("GET /api/decisions — lists pending decisions by default", async () => {
    const req = new Request(
      `http://localhost/api/decisions?hiveId=${hiveId}`,
    );

    const res = await getDecisions(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const dec = body.data.find((d: { id: string }) => d.id === decisionId);
    expect(dec).toBeDefined();
    expect(dec.status).toBe("pending");
    expect(dec.priority).toBe("urgent");
  });

  it("GET /api/decisions — orders urgent before normal", async () => {
    // Insert a normal-priority decision
    const [normalDec] = await sql`
      INSERT INTO decisions (hive_id, title, context, priority, status)
      VALUES (${hiveId}, 'Normal decision', 'Some context', 'normal', 'pending')
      RETURNING id
    `;

    const req = new Request(
      `http://localhost/api/decisions?hiveId=${hiveId}`,
    );

    const res = await getDecisions(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    const urgentIdx = body.data.findIndex((d: { id: string }) => d.id === decisionId);
    const normalIdx = body.data.findIndex((d: { id: string }) => d.id === normalDec.id);
    expect(urgentIdx).toBeLessThan(normalIdx);
  });

  it("POST /api/decisions/[id]/respond — responds with approved", async () => {
    const req = new Request(
      `http://localhost/api/decisions/${decisionId}/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "approved", comment: "Looks good" }),
      },
    );

    const res = await respondToDecision(req, {
      params: Promise.resolve({ id: decisionId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("resolved");
    expect(body.data.ownerResponse).toBe("approved: Looks good");
    expect(body.data.resolvedAt).not.toBeNull();
  });

  it("POST /api/decisions/[id]/respond — persists selected named option metadata", async () => {
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, goal_id, title, context, recommendation, options, priority, status)
      VALUES (
        ${hiveId},
        ${goalId},
        'Choose Gemini CLI auth path',
        'The owner needs to pick one of several runtime auth paths.',
        'Use the GCA login path.',
        ${sql.json({
          options: [
            { key: "api-key", label: "Use API key", response: "approved" },
            { key: "gca-login", label: "Use GCA login", response: "approved" },
          ],
        })},
        'urgent',
        'pending'
      )
      RETURNING id
    `;

    const res = await respondToDecision(
      new Request(`http://localhost/api/decisions/${decision.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedOptionKey: "gca-login" }),
      }),
      { params: Promise.resolve({ id: decision.id }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("resolved");
    expect(body.data.ownerResponse).toBe("approved");
    expect(body.data.selectedOptionKey).toBe("gca-login");
    expect(body.data.selectedOptionLabel).toBe("Use GCA login");

    const [row] = await sql<{
      status: string;
      owner_response: string;
      selected_option_key: string;
      selected_option_label: string;
    }[]>`
      SELECT status, owner_response, selected_option_key, selected_option_label
      FROM decisions
      WHERE id = ${decision.id}
    `;
    expect(row.status).toBe("resolved");
    expect(row.owner_response).toBe("approved");
    expect(row.selected_option_key).toBe("gca-login");
    expect(row.selected_option_label).toBe("Use GCA login");
  });

  it("POST /api/decisions/[id]/respond — approved release-scan proposal queues one model-registry patch task", async () => {
    const releaseDecisionId = await createReleaseScanModelDecision();
    const req = new Request(
      `http://localhost/api/decisions/${releaseDecisionId}/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "approved", comment: "Ship it" }),
      },
    );

    const res = await respondToDecision(req, {
      params: Promise.resolve({ id: releaseDecisionId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("resolved");
    expect(body.data.queuedTaskId).toEqual(expect.any(String));

    const tasks = await sql<{ id: string; title: string; brief: string; acceptance_criteria: string | null }[]>`
      SELECT id, title, brief, acceptance_criteria
      FROM tasks
      WHERE created_by = 'decision-release-scan'
        AND brief LIKE ${`%release-scan-decision:${releaseDecisionId}%`}
      ORDER BY created_at ASC
    `;

    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(body.data.queuedTaskId);
    expect(tasks[0].title).toBe("Patch model registry for openai/gpt-5.5");
    expect(tasks[0].brief).toContain("src/adapters/provider-config.ts");
    expect(tasks[0].brief).toContain("roles model list");
    expect(tasks[0].brief).toContain("adapter settings model list");
    expect(tasks[0].brief).toContain("hive creation model list");
    expect(tasks[0].brief).toContain("Verify the model is selectable in the roles dropdown.");
    expect(tasks[0].brief).toContain("Verify the model is selectable in the adapter settings dropdown.");
    expect(tasks[0].brief).toContain("Verify the model is selectable in the hive creation dropdown.");
    expect(tasks[0].brief).toContain("Verify a role can be assigned to the model.");
    expect(tasks[0].brief).toContain("Verify dispatcher cost tracker coverage");
    expect(tasks[0].brief).toContain("Run `npm run build` after the patch.");
    expect(tasks[0].brief).toContain("Commit the implementation with a clear conventional commit message.");
    expect(tasks[0].acceptance_criteria).toContain("dispatcher cost tracker covers the model");
  });

  it("POST /api/decisions/[id]/respond — rejected and discussed release-scan proposals queue no patch task", async () => {
    for (const response of ["rejected", "discussed"] as const) {
      const releaseDecisionId = await createReleaseScanModelDecision();
      const res = await respondToDecision(
        new Request(`http://localhost/api/decisions/${releaseDecisionId}/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ response, comment: "Not yet" }),
        }),
        { params: Promise.resolve({ id: releaseDecisionId }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.queuedTaskId).toBeNull();

      const tasks = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM tasks
        WHERE created_by = 'decision-release-scan'
          AND brief LIKE ${`%release-scan-decision:${releaseDecisionId}%`}
      `;
      expect(Number(tasks[0].count)).toBe(0);
    }
  });

  it("POST /api/decisions/[id]/respond — direct QA-cap retry actions reopen the linked task", async () => {
    for (const response of ["retry_with_different_role", "refine_brief_and_retry"] as const) {
      const direct = await createDirectTaskQaCapDecision();
      const res = await respondToDecision(
        new Request(`http://localhost/api/decisions/${direct.decisionId}/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ response, comment: "Use the latest QA notes" }),
        }),
        { params: Promise.resolve({ id: direct.decisionId }) },
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.status).toBe("resolved");
      expect(body.data.ownerResponse).toBe(`${response}: Use the latest QA notes`);

      const [task] = await sql<{
        status: string;
        retry_count: number;
        failure_reason: string | null;
        brief: string;
      }[]>`
        SELECT status, retry_count, failure_reason, brief
        FROM tasks
        WHERE id = ${direct.taskId}
      `;
      expect(task.status).toBe("pending");
      expect(task.retry_count).toBe(0);
      expect(task.failure_reason).toBeNull();
      expect(task.brief).toContain("## Owner Recovery Decision");
      expect(task.brief).toContain("Use the latest QA notes");
    }
  });

  it("POST /api/decisions/[id]/respond — direct QA-cap abandon cancels the linked task", async () => {
    const direct = await createDirectTaskQaCapDecision();
    const res = await respondToDecision(
      new Request(`http://localhost/api/decisions/${direct.decisionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "abandon", comment: "No longer useful" }),
      }),
      { params: Promise.resolve({ id: direct.decisionId }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("resolved");
    expect(body.data.ownerResponse).toBe("abandon: No longer useful");

    const [task] = await sql<{ status: string; failure_reason: string | null }[]>`
      SELECT status, failure_reason
      FROM tasks
      WHERE id = ${direct.taskId}
    `;
    expect(task.status).toBe("cancelled");
    expect(task.failure_reason).toContain("Abandoned by owner");
  });

  it("POST /api/decisions/[id]/respond — duplicate approval returns existing model-registry patch task", async () => {
    const releaseDecisionId = await createReleaseScanModelDecision();

    const first = await respondToDecision(
      new Request(`http://localhost/api/decisions/${releaseDecisionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "approved", comment: "Approved" }),
      }),
      { params: Promise.resolve({ id: releaseDecisionId }) },
    );
    const second = await respondToDecision(
      new Request(`http://localhost/api/decisions/${releaseDecisionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "approved", comment: "Approved again" }),
      }),
      { params: Promise.resolve({ id: releaseDecisionId }) },
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody.data.queuedTaskId).toBe(firstBody.data.queuedTaskId);

    const tasks = await sql<{ id: string }[]>`
      SELECT id
      FROM tasks
      WHERE created_by = 'decision-release-scan'
        AND brief LIKE ${`%release-scan-decision:${releaseDecisionId}%`}
    `;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(firstBody.data.queuedTaskId);
  });

  it("POST /api/decisions/[id]/respond — rejects invalid response value", async () => {
    const req = new Request(
      `http://localhost/api/decisions/${decisionId}/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "maybe" }),
      },
    );

    const res = await respondToDecision(req, {
      params: Promise.resolve({ id: decisionId }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid response/i);
  });

  it("POST /api/decisions/[id]/respond — returns 404 for unknown decision", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const req = new Request(
      `http://localhost/api/decisions/${fakeId}/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "rejected" }),
      },
    );

    const res = await respondToDecision(req, {
      params: Promise.resolve({ id: fakeId }),
    });

    expect(res.status).toBe(404);
  });

  it("GET /api/decisions — response includes taskId field on each decision", async () => {
    // Resolve the seeded decision so we can query resolved ones
    await respondToDecision(
      new Request(`http://localhost/api/decisions/${decisionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "approved", comment: "done" }),
      }),
      { params: Promise.resolve({ id: decisionId }) },
    );

    const req = new Request(
      `http://localhost/api/decisions?hiveId=${hiveId}&status=resolved`,
    );

    const res = await getDecisions(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0]).toHaveProperty("taskId");
  });
});

describe("POST /api/decisions", () => {
  it("POST /api/decisions — creates a decision with taskId", async () => {
    const req = new Request("http://localhost/api/decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        taskId,
        question: "Which database should we use?",
        context: "We need to pick a database for the new service.",
        options: ["PostgreSQL", "MySQL", "MongoDB"],
      }),
    });

    const res = await postDecision(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.hiveId).toBe(hiveId);
    expect(body.data.taskId).toBe(taskId);
    expect(body.data.title).toBe("Which database should we use?");
    expect(body.data.context).toBe("We need to pick a database for the new service.");
    expect(body.data.options).toEqual(["PostgreSQL", "MySQL", "MongoDB"]);
    expect(body.data.priority).toBe("normal");
    // EA-first pipeline: new system decisions land in 'ea_review' for the
    // EA to attempt autonomous resolution before reaching the owner.
    expect(body.data.status).toBe("ea_review");
  });

  it("POST /api/decisions — accepts optional goalId and priority", async () => {
    const req = new Request("http://localhost/api/decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        taskId,
        question: "High priority question?",
        context: "Needs urgent attention.",
        options: [],
        goalId,
        priority: "urgent",
      }),
    });

    const res = await postDecision(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.goalId).toBe(goalId);
    expect(body.data.priority).toBe("urgent");
  });

  it("POST /api/decisions — blocks duplicate recovery decisions for a task family", async () => {
    await sql`
      INSERT INTO decisions (hive_id, goal_id, task_id, title, context, recommendation, priority, status)
      VALUES (
        ${hiveId},
        ${goalId},
        ${taskId},
        'Existing recovery decision',
        'Already waiting for EA review.',
        'Do not ask again.',
        'urgent',
        'ea_review'
      )
    `;

    const req = new Request("http://localhost/api/decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        taskId,
        goalId,
        question: "Duplicate recovery question?",
        context: "This would ask again for the same task family.",
        options: ["Retry", "Abandon"],
      }),
    });

    const res = await postDecision(req);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("Recovery budget exhausted");

    const duplicate = await sql`
      SELECT id FROM decisions WHERE title = 'Duplicate recovery question?'
    `;
    expect(duplicate).toHaveLength(0);

    const [parked] = await sql`
      SELECT status, failure_reason FROM tasks WHERE id = ${taskId}
    `;
    expect(parked.status).toBe("unresolvable");
    expect(parked.failure_reason).toContain("open recovery decisions");
  });

  it("POST /api/decisions — returns 400 for missing required fields", async () => {
    const req = new Request("http://localhost/api/decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId, taskId }),
    });

    const res = await postDecision(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing required fields/i);
  });
});

describe("PATCH /api/decisions/[id] cross-hive guard", () => {
  it("does not mutate a linked task in a different hive than the decision", async () => {
    const [otherHive] = await sql`
      INSERT INTO hives (slug, name, type)
      VALUES (${PREFIX + "biz2"}, 'P5 GD Test Hive 2', 'digital')
      RETURNING id
    `;
    const [foreignTask] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (
        ${otherHive.id},
        'dev-agent',
        'owner',
        'Foreign hive task',
        'Untouched brief',
        'completed'
      )
      RETURNING id
    `;
    // Corrupt decisions.task_id to point at a task outside its hive — the
    // bad-data shape the audit 2026-04-22 guard is meant to defend against.
    await sql`
      UPDATE decisions SET task_id = ${foreignTask.id} WHERE id = ${decisionId}
    `;

    const req = new Request(`http://localhost/api/decisions/${decisionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "resolved", ownerResponse: "go ahead" }),
    });
    const res = await patchDecision(req, {
      params: Promise.resolve({ id: decisionId }),
    });

    expect(res.status).toBe(500);

    const [task] = await sql<{ status: string; brief: string }[]>`
      SELECT status, brief FROM tasks WHERE id = ${foreignTask.id}
    `;
    expect(task.status).toBe("completed");
    expect(task.brief).toBe("Untouched brief");
  });
});

describe("Schedules API", () => {
  it("POST /api/schedules — creates a schedule", async () => {
    const taskTemplate = {
      assignedTo: "researcher",
      title: "Weekly market report",
      brief: "Compile weekly market analysis",
      priority: 3,
    };

    const req = new Request("http://localhost/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        cronExpression: "0 9 * * 1",
        taskTemplate,
        createdBy: "owner",
      }),
    });

    const res = await postSchedule(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.hiveId).toBe(hiveId);
    expect(body.data.cronExpression).toBe("0 9 * * 1");
    expect(body.data.taskTemplate).toEqual(taskTemplate);
    expect(body.data.enabled).toBe(true);
  });

  it("POST /api/schedules — returns 400 for missing fields", async () => {
    const req = new Request("http://localhost/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId, cronExpression: "0 9 * * 1" }),
    });

    const res = await postSchedule(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing required fields/i);
  });

  it("GET /api/schedules — lists schedules filtered by hiveId", async () => {
    // Create a schedule first
    const taskTemplate = { assignedTo: "researcher", title: "Weekly report", brief: "Compile analysis", priority: 3 };
    await postSchedule(
      new Request("http://localhost/api/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId, cronExpression: "0 9 * * 1", taskTemplate, createdBy: "owner" }),
      }),
    );

    const req = new Request(
      `http://localhost/api/schedules?hiveId=${hiveId}`,
    );

    const res = await getSchedules(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].hiveId).toBe(hiveId);
    expect(body.data[0].cronExpression).toBeDefined();
    expect(body.data[0].taskTemplate).toBeDefined();
  });

  it("PATCH /api/schedules — preserves a named schedule on non-name edits and persists explicit renames", async () => {
    const [schedule] = await sql<{ id: string }[]>`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, created_by)
      VALUES (
        ${hiveId},
        '0 9 * * 1',
        ${sql.json({
          assignedTo: "dev-agent",
          title: "Weekly implementation review",
          brief: "Original brief",
        })},
        true,
        'owner'
      )
      RETURNING id
    `;

    const editRes = await patchSchedule(
      new Request("http://localhost/api/schedules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: schedule.id,
          taskTemplate: {
            assignedTo: "dev-agent",
            title: "",
            brief: "Updated brief",
          },
        }),
      }),
    );
    expect(editRes.status).toBe(200);

    const [afterEdit] = await sql<{ task_template: { title?: string; brief?: string } }[]>`
      SELECT task_template FROM schedules WHERE id = ${schedule.id}
    `;
    expect(afterEdit.task_template.title).toBe("Weekly implementation review");
    expect(afterEdit.task_template.brief).toBe("Updated brief");

    const renameRes = await patchSchedule(
      new Request("http://localhost/api/schedules", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: schedule.id,
          taskTemplate: {
            assignedTo: "dev-agent",
            title: "Renamed implementation review",
            brief: "Updated brief",
          },
        }),
      }),
    );
    expect(renameRes.status).toBe(200);

    const [afterRename] = await sql<{ task_template: { title?: string; brief?: string } }[]>`
      SELECT task_template FROM schedules WHERE id = ${schedule.id}
    `;
    expect(afterRename.task_template.title).toBe("Renamed implementation review");
    expect(afterRename.task_template.brief).toBe("Updated brief");
  });
});
