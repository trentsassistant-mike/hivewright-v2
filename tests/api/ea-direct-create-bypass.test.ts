import { beforeEach, describe, expect, it } from "vitest";
import { POST as createGoal } from "@/app/api/goals/route";
import { POST as createTask } from "@/app/api/tasks/route";
import { POST as createWork } from "@/app/api/work/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;
let eaThreadId: string;
let eaOwnerMessageId: string;

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Dev Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type)
    VALUES ('ea-direct-create', 'EA Direct Create', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;
  const [thread] = await sql<{ id: string }[]>`
    INSERT INTO ea_threads (hive_id, channel_id)
    VALUES (${hiveId}, ${`dashboard:${hiveId}`})
    RETURNING id
  `;
  eaThreadId = thread.id;
  const [message] = await sql<{ id: string }[]>`
    INSERT INTO ea_messages (thread_id, role, content, source)
    VALUES (${eaThreadId}, 'owner', 'Please make this happen', 'dashboard')
    RETURNING id
  `;
  eaOwnerMessageId = message.id;
});

function eaHeaders() {
  return {
    "Content-Type": "application/json",
    "X-HiveWright-EA-Source-Hive-Id": hiveId,
    "X-HiveWright-EA-Thread-Id": eaThreadId,
    "X-HiveWright-EA-Owner-Message-Id": eaOwnerMessageId,
    "X-HiveWright-EA-Source": "dashboard",
  };
}

function postJson(path: "/api/work" | "/api/tasks" | "/api/goals", body: Record<string, unknown>) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: eaHeaders(),
    body: JSON.stringify(body),
  });
}

async function errorBody(response: Response) {
  return await response.json() as { error?: string; code?: string };
}

describe("EA-origin work intake routing", () => {
  it("routes normal EA owner work through /api/work without a direct-create bypass reason", async () => {
    const response = await createWork(postJson("/api/work", {
      hiveId,
      assignedTo: "dev-agent",
      input: "Fix the owner dashboard empty state.",
    }));

    expect(response.status).toBe(201);
    const body = await response.json() as { data: { id: string; type: string } };
    expect(body.data.type).toBe("task");

    const [task] = await sql<{ brief: string; created_by: string }[]>`
      SELECT brief, created_by FROM tasks WHERE id = ${body.data.id}
    `;
    expect(task.brief).toBe("Fix the owner dashboard empty state.");
    expect(task.created_by).toBe("owner");
  });
});

describe("EA-origin direct task/goal create bypass guard", () => {
  it("rejects EA direct task creation without bypassReason", async () => {
    const response = await createTask(postJson("/api/tasks", {
      hiveId,
      assignedTo: "dev-agent",
      title: "Direct task",
      brief: "This direct create lacks a reason.",
      createdBy: "ea",
    }));

    expect(response.status).toBe(400);
    expect(await errorBody(response)).toMatchObject({
      code: "EA_DIRECT_CREATE_BYPASS_REASON_REQUIRED",
    });
    const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM tasks`;
    expect(n).toBe(0);
  });

  it("rejects EA direct goal creation without bypassReason", async () => {
    const response = await createGoal(postJson("/api/goals", {
      hiveId,
      title: "Direct goal",
      description: "This direct create lacks a reason.",
    }));

    expect(response.status).toBe(400);
    expect(await errorBody(response)).toMatchObject({
      code: "EA_DIRECT_CREATE_BYPASS_REASON_REQUIRED",
    });
    const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM goals`;
    expect(n).toBe(0);
  });

  it("accepts an EA break-glass direct task create and persists bypass audit metadata", async () => {
    const bypassReason = "Work intake classifier is unavailable during incident response.";
    const response = await createTask(postJson("/api/tasks", {
      hiveId,
      assignedTo: "dev-agent",
      title: "Break-glass task",
      brief: "Create directly while intake is unavailable.",
      createdBy: "ea",
      bypassReason,
    }));

    expect(response.status).toBe(201);
    const body = await response.json() as { data: { id: string } };
    const [audit] = await sql<{
      event_type: string;
      actor_type: string;
      actor_id: string | null;
      hive_id: string;
      task_id: string | null;
      target_type: string;
      target_id: string | null;
      outcome: string;
      metadata: {
        bypassReason?: string;
        route?: string;
        source?: string;
        sourceHiveId?: string;
        eaThreadId?: string;
        ownerMessageId?: string;
        createdResourceType?: string;
        createdResourceId?: string;
      };
    }[]>`
      SELECT event_type, actor_type, actor_id, hive_id, task_id, target_type,
             target_id, outcome, metadata
      FROM agent_audit_events
      WHERE event_type = 'ea.direct_create_bypass'
    `;

    expect(audit).toMatchObject({
      event_type: "ea.direct_create_bypass",
      actor_type: "agent",
      actor_id: "ea",
      hive_id: hiveId,
      task_id: body.data.id,
      target_type: "task",
      target_id: body.data.id,
      outcome: "success",
    });
    expect(audit.metadata).toMatchObject({
      bypassReason,
      route: "/api/tasks",
      source: "dashboard",
      sourceHiveId: hiveId,
      eaThreadId,
      ownerMessageId: eaOwnerMessageId,
      createdResourceType: "task",
      createdResourceId: body.data.id,
    });
  });
});
