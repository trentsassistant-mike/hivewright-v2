import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../../_lib/test-db";
import { GET } from "../../../src/app/api/active-tasks/route";

const BIZ_A = "44444444-4444-4444-4444-444444444444";
const BIZ_B = "55555555-5555-5555-5555-555555555555";

describe("GET /api/active-tasks", () => {
  beforeEach(async () => {
    await truncateAll(sql);
    await sql`
      INSERT INTO hives (id, slug, name, type) VALUES
        (${BIZ_A}, 'biz-a-active', 'Biz A', 'digital'),
        (${BIZ_B}, 'biz-b-active', 'Biz B', 'digital')
    `;
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('dev-agent', 'Developer Agent', 'executor', 'claude-code'),
             ('ops-agent', 'Operator', 'executor', 'claude-code')
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        type = EXCLUDED.type,
        adapter_type = EXCLUDED.adapter_type
    `;
    await sql`
      INSERT INTO goals (id, hive_id, title, status)
      VALUES ('66666666-6666-6666-6666-666666666666', ${BIZ_A}, 'Launch governed agents', 'active')
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, parent_task_id, goal_id, started_at, model_used, adapter_override, model_override)
      VALUES
        (${BIZ_A}, 'dev-agent', 'owner', 'active', 'Build feature X', 'brief-x', NULL, '66666666-6666-6666-6666-666666666666', NOW() - INTERVAL '5 minutes', 'anthropic/claude-sonnet-4-6', NULL, 'anthropic/claude-sonnet-4-6'),
        (${BIZ_A}, 'ops-agent', 'owner', 'active', 'Rotate creds',   'brief-r', NULL, NULL, NOW() - INTERVAL '1 minute', NULL, 'codex', NULL),
        (${BIZ_A}, 'dev-agent', 'owner', 'pending',     'Queued task',    'brief-q', NULL, NULL, NULL, NULL, NULL, NULL),
        (${BIZ_A}, 'dev-agent', 'owner', 'blocked',     'Blocked task',   'brief-b', NULL, NULL, NULL, NULL, NULL, NULL),
        (${BIZ_A}, 'ops-agent', 'owner', 'unresolvable','Unresolvable adapter failure', 'brief-u', NULL, NULL, NULL, NULL, NULL, NULL),
        (${BIZ_A}, 'ops-agent', 'owner', 'failed',      'Failed workflow', 'brief-f', NULL, NULL, NULL, NULL, NULL, NULL),
        (${BIZ_A}, 'dev-agent', 'owner', 'completed',   'Done task',      'brief-d', NULL, NULL, NOW() - INTERVAL '1 hour', 'anthropic/claude-sonnet-4-6', NULL, NULL),
        (${BIZ_B}, 'dev-agent', 'owner', 'active', 'Other biz',      'brief-o', NULL, NULL, NOW(), NULL, NULL, NULL)
    `;
    await sql`
      INSERT INTO decisions (hive_id, title, context, priority, status, kind, created_at)
      VALUES
        (${BIZ_A}, 'Owner runtime decision', 'ctx', 'urgent', 'pending', 'decision', NOW() - INTERVAL '2 minutes'),
        (${BIZ_A}, 'EA review escalation', 'ctx', 'high', 'ea_review', 'unresolvable_task_triage', NOW() - INTERVAL '3 minutes'),
        (${BIZ_A}, 'Resolved old decision', 'ctx', 'normal', 'resolved', 'decision', NOW() - INTERVAL '4 minutes'),
        (${BIZ_B}, 'Other hive decision', 'ctx', 'urgent', 'pending', 'decision', NOW())
    `;
  });

  it("returns only active tasks for the requested hive, newest-first", async () => {
    const req = new Request(`http://localhost/api/active-tasks?hiveId=${BIZ_A}`);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tasks: {
        id: string;
        title: string;
        assignedTo: string;
        createdBy: string;
        status: string;
        parentTaskId: string | null;
        goalId: string | null;
        goalTitle: string | null;
        roleName: string | null;
        recommendedModel: string | null;
        adapterType: string | null;
        adapterOverride: string | null;
        modelOverride: string | null;
        startedAt: string;
        createdAt: string;
        updatedAt: string;
        modelUsed: string | null;
      }[];
    };
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[0].title).toBe("Rotate creds");
    expect(body.tasks[1].title).toBe("Build feature X");
    expect(body.tasks[0].assignedTo).toBe("ops-agent");
    expect(body.tasks[0].startedAt).toBeTypeOf("string");
    expect(body.tasks[0].modelUsed).toBeNull();
    expect(body.tasks[0].adapterType).toBe("codex");
    expect(body.tasks[0].adapterOverride).toBe("codex");
    expect(body.tasks[1].modelUsed).toBe("anthropic/claude-sonnet-4-6");
    expect(body.tasks[1]).toMatchObject({
      createdBy: "owner",
      status: "active",
      parentTaskId: null,
      goalId: "66666666-6666-6666-6666-666666666666",
      goalTitle: "Launch governed agents",
      roleName: "Developer Agent",
      adapterType: "claude-code",
      modelOverride: "anthropic/claude-sonnet-4-6",
    });
    expect(body.tasks[1].createdAt).toBeTypeOf("string");
    expect(body.tasks[1].updatedAt).toBeTypeOf("string");
  });

  it("keeps the default feed active-only but exposes critical parked items when requested", async () => {
    const req = new Request(`http://localhost/api/active-tasks?hiveId=${BIZ_A}&includeCritical=true`);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tasks: { title: string; status: string }[];
      criticalItems: {
        id: string;
        title: string;
        sourceType: "task" | "decision";
        status: string;
        href: string;
        updatedAt: string | null;
      }[];
    };

    expect(body.tasks.map((task) => task.status)).toEqual(["active", "active"]);
    expect(body.criticalItems.map((item) => [item.sourceType, item.status, item.title])).toEqual([
      ["task", "failed", "Failed workflow"],
      ["task", "unresolvable", "Unresolvable adapter failure"],
      ["task", "blocked", "Blocked task"],
      ["decision", "pending", "Owner runtime decision"],
    ]);
    expect(body.criticalItems.every((item) => item.href.startsWith(`/${item.sourceType === "task" ? "tasks" : "decisions"}/`))).toBe(true);
  });

  it("keeps owner-brief critical decisions aligned to the default decisions feed", async () => {
    await sql`
      INSERT INTO decisions (hive_id, title, context, priority, status, kind, created_at)
      VALUES
        (${BIZ_A}, 'Webhook approval', 'ctx', 'normal', 'pending', 'external_action_approval', NOW() - INTERVAL '5 minutes'),
        (${BIZ_A}, 'Supervisor follow-up', 'ctx', 'normal', 'pending', 'supervisor_flagged', NOW() - INTERVAL '6 minutes'),
        (${BIZ_A}, 'Learning gate follow-up', 'ctx', 'normal', 'pending', 'learning_gate_followup', NOW() - INTERVAL '7 minutes')
    `;

    const res = await GET(new Request(`http://localhost/api/active-tasks?hiveId=${BIZ_A}&includeCritical=true`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      criticalItems: {
        title: string;
        sourceType: "task" | "decision";
        status: string;
      }[];
    };

    expect(
      body.criticalItems.filter((item) => item.sourceType === "decision").map((item) => item.title),
    ).toEqual(["Owner runtime decision"]);
  });

  it("keeps parked tasks in the critical feed when failed and unresolvable work is noisy", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, started_at)
      SELECT ${BIZ_A}, 'dev-agent', 'owner', 'failed', 'Noisy failed task ' || series, 'brief', NULL
      FROM generate_series(1, 8) AS series
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, started_at)
      SELECT ${BIZ_A}, 'ops-agent', 'owner', 'unresolvable', 'Noisy unresolvable task ' || series, 'brief', NULL
      FROM generate_series(1, 8) AS series
    `;

    const res = await GET(new Request(`http://localhost/api/active-tasks?hiveId=${BIZ_A}&includeCritical=true`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      criticalItems: {
        title: string;
        sourceType: "task" | "decision";
        status: string;
      }[];
    };

    expect(body.criticalItems).toContainEqual(
      expect.objectContaining({ sourceType: "task", status: "blocked", title: "Blocked task" }),
    );
  });

  it("marks achieved-goal failures as historical while direct failures stay live blocking", async () => {
    await sql`
      INSERT INTO goals (id, hive_id, title, status)
      VALUES ('77777777-7777-7777-7777-777777777777', ${BIZ_A}, 'Completed goal', 'achieved')
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, goal_id, started_at)
      VALUES
        (${BIZ_A}, 'dev-agent', 'owner', 'failed', 'Old achieved goal failure', 'brief-old', '77777777-7777-7777-7777-777777777777', NULL),
        (${BIZ_A}, 'dev-agent', 'owner', 'failed', 'Direct live failure', 'brief-direct', NULL, NULL)
    `;

    const res = await GET(new Request(`http://localhost/api/active-tasks?hiveId=${BIZ_A}&includeCritical=true`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      criticalItems: {
        title: string;
        sourceType: "task" | "decision";
        status: string;
        goalStatus: string | null;
        liveBlocking: boolean;
      }[];
    };

    expect(body.criticalItems).toContainEqual(
      expect.objectContaining({
        sourceType: "task",
        title: "Old achieved goal failure",
        goalStatus: "achieved",
        liveBlocking: false,
      }),
    );
    expect(body.criticalItems).toContainEqual(
      expect.objectContaining({
        sourceType: "task",
        title: "Direct live failure",
        goalStatus: null,
        liveBlocking: true,
      }),
    );
  });

  it("returns 400 when hiveId is missing", async () => {
    const res = await GET(new Request("http://localhost/api/active-tasks"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when hiveId is not a valid UUID", async () => {
    const res = await GET(new Request("http://localhost/api/active-tasks?hiveId=not-a-uuid"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("UUID");
  });
});
