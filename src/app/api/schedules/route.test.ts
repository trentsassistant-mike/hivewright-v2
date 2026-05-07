import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), {
    json: vi.fn((value: unknown) => value),
    unsafe: vi.fn(),
  });
  return {
    sql,
    requireApiAuth: vi.fn(),
    requireApiUser: vi.fn(),
    requireSystemOwner: vi.fn(),
    canAccessHive: vi.fn(),
  };
});

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
  requireApiUser: mocks.requireApiUser,
  requireSystemOwner: mocks.requireSystemOwner,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

import { GET, PATCH, POST } from "./route";

function request(body: unknown, method: "PATCH" | "POST") {
  return new Request("http://localhost/api/schedules", {
    method,
    body: JSON.stringify(body),
  });
}

describe("PATCH/POST /api/schedules owner gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue(null);
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.requireSystemOwner.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.canAccessHive.mockResolvedValue(true);
  });

  it("rejects schedule reads for authenticated non-members of a requested hive", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/schedules?hiveId=hive-a"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot access this hive");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-a");
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("filters broad non-owner schedule reads to accessible hives", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mocks.sql.unsafe.mockResolvedValueOnce([{ total: "0" }]).mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/schedules?limit=10&offset=0"));

    expect(res.status).toBe(200);
    expect(mocks.sql.unsafe).toHaveBeenCalledTimes(2);
    expect(mocks.sql.unsafe.mock.calls[0][0]).toContain("hive_memberships");
    expect(mocks.sql.unsafe.mock.calls[0][1]).toEqual(["member-1"]);
  });

  it("normalizes stringified task templates when listing schedules", async () => {
    const createdAt = new Date("2026-04-27T00:00:00.000Z");
    mocks.sql.unsafe
      .mockResolvedValueOnce([{ total: "1" }])
      .mockResolvedValueOnce([
        {
          id: "schedule-1",
          hive_id: "hive-1",
          cron_expression: "0 9 * * 1",
          task_template: JSON.stringify({
            assignedTo: "researcher",
            title: "Weekly report",
            brief: "Compile analysis",
          }),
          enabled: true,
          last_run_at: null,
          next_run_at: null,
          created_by: "owner-1",
          created_at: createdAt,
        },
      ]);

    const res = await GET(new Request("http://localhost/api/schedules?hiveId=hive-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data[0].taskTemplate).toEqual({
      assignedTo: "researcher",
      title: "Weekly report",
      brief: "Compile analysis",
    });
  });

  it("preserves unauthenticated denial before the owner gate", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const res = await POST(request({
      hiveId: "hive-1",
      cronExpression: "*/5 * * * *",
      taskTemplate: { title: "Check hive" },
    }, "POST"));

    expect(res.status).toBe(401);
    expect(mocks.requireSystemOwner).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects authenticated non-owner callers before patching schedules", async () => {
    mocks.requireSystemOwner.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({ error: "Forbidden: system owner role required" }),
        { status: 403 },
      ),
    });

    const res = await PATCH(request({ id: "schedule-1", enabled: false }, "PATCH"));

    expect(res.status).toBe(403);
    expect(mocks.requireApiAuth).toHaveBeenCalledTimes(1);
    expect(mocks.requireSystemOwner).toHaveBeenCalledTimes(1);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects authenticated non-owner callers before creating schedules", async () => {
    mocks.requireSystemOwner.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({ error: "Forbidden: system owner role required" }),
        { status: 403 },
      ),
    });

    const res = await POST(request({
      hiveId: "hive-1",
      cronExpression: "*/5 * * * *",
      taskTemplate: { title: "Check hive" },
    }, "POST"));

    expect(res.status).toBe(403);
    expect(mocks.requireApiAuth).toHaveBeenCalledTimes(1);
    expect(mocks.requireSystemOwner).toHaveBeenCalledTimes(1);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("allows system owners to patch schedule enabled state", async () => {
    const createdAt = new Date("2026-04-27T00:00:00.000Z");
    mocks.sql.unsafe.mockResolvedValueOnce([
      {
        id: "schedule-1",
        hive_id: "hive-1",
        cron_expression: "*/5 * * * *",
        task_template: { title: "Check hive" },
        enabled: false,
        last_run_at: null,
        next_run_at: null,
        created_by: "owner-1",
        created_at: createdAt,
      },
    ]);

    const res = await PATCH(request({ id: "schedule-1", enabled: false }, "PATCH"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      id: "schedule-1",
      hiveId: "hive-1",
      cronExpression: "*/5 * * * *",
      taskTemplate: { title: "Check hive" },
      enabled: false,
      lastRunAt: null,
      nextRunAt: null,
      createdBy: "owner-1",
      createdAt: createdAt.toISOString(),
    });
    expect(mocks.sql.unsafe).toHaveBeenCalledTimes(1);
  });

  it("rejects enabling a schedule while its hive is paused", async () => {
    mocks.sql
      .mockResolvedValueOnce([{ hive_id: "hive-1" }])
      .mockResolvedValueOnce([{
        paused: true,
        reason: "Recovery",
        paused_by: "owner@example.com",
        updated_at: new Date("2026-05-02T06:00:00.000Z"),
        operating_state: "paused",
        schedule_snapshot: ["schedule-1"],
      }]);

    const res = await PATCH(request({ id: "schedule-1", enabled: true }, "PATCH"));
    const body = await res.json();

    expect(res.status).toBe(423);
    expect(body.code).toBe("HIVE_CREATION_PAUSED");
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("updates cron expressions and recomputes next_run_at in the same update", async () => {
    mocks.sql.unsafe.mockResolvedValueOnce([
      {
        id: "schedule-1",
        hive_id: "hive-1",
        cron_expression: "*/15 * * * *",
        task_template: { assignedTo: "dev-agent", title: "Review", brief: "Check work" },
        enabled: true,
        last_run_at: null,
        next_run_at: new Date("2026-04-27T00:15:00.000Z"),
        created_by: "scheduler",
        created_at: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);

    const res = await PATCH(request({ id: "schedule-1", cronExpression: "*/15 * * * *" }, "PATCH"));

    expect(res.status).toBe(200);
    const [query, values] = mocks.sql.unsafe.mock.calls[0];
    expect(query).toContain("cron_expression");
    expect(query).toContain("next_run_at");
    expect(query).toContain("RETURNING");
    expect(values[0]).toBe("*/15 * * * *");
    expect(values[1]).toBeInstanceOf(Date);
  });

  it("rejects invalid cron expressions", async () => {
    const res = await PATCH(request({ id: "schedule-1", cronExpression: "not cron" }, "PATCH"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/Invalid cronExpression/);
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("rejects unknown assigned roles", async () => {
    mocks.sql.mockResolvedValueOnce([]);

    const res = await PATCH(request({
      id: "schedule-1",
      taskTemplate: { assignedTo: "missing-role", title: "Review", brief: "Check work" },
    }, "PATCH"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Unknown assigned role: missing-role");
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });

  it("preserves an existing schedule title when editing other task template fields", async () => {
    mocks.sql.mockResolvedValueOnce([{ slug: "dev-agent" }]);
    mocks.sql.unsafe.mockResolvedValueOnce([
      {
        id: "schedule-1",
        hive_id: "hive-1",
        cron_expression: "*/5 * * * *",
        task_template: {
          assignedTo: "dev-agent",
          title: "Custom schedule name",
          brief: "Updated brief",
          kind: "task",
        },
        enabled: true,
        last_run_at: null,
        next_run_at: null,
        created_by: "scheduler",
        created_at: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);

    const res = await PATCH(request({
      id: "schedule-1",
      taskTemplate: {
        assignedTo: "dev-agent",
        brief: "Updated brief",
      },
    }, "PATCH"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.taskTemplate.title).toBe("Custom schedule name");
    const [query, values] = mocks.sql.unsafe.mock.calls[0];
    expect(query).toContain("jsonb_typeof(task_template)");
    expect(query).toContain(") ||");
    expect(values).toContainEqual({
      assignedTo: "dev-agent",
      brief: "Updated brief",
    });
  });

  it("treats a blank schedule title as omitted so ordinary edits keep the existing title", async () => {
    mocks.sql.mockResolvedValueOnce([{ slug: "dev-agent" }]);
    mocks.sql.unsafe.mockResolvedValueOnce([
      {
        id: "schedule-1",
        hive_id: "hive-1",
        cron_expression: "*/5 * * * *",
        task_template: {
          assignedTo: "dev-agent",
          title: "Custom schedule name",
          brief: "Updated brief",
          kind: "task",
        },
        enabled: true,
        last_run_at: null,
        next_run_at: null,
        created_by: "scheduler",
        created_at: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);

    const res = await PATCH(request({
      id: "schedule-1",
      taskTemplate: {
        assignedTo: "dev-agent",
        title: "",
        brief: "Updated brief",
      },
    }, "PATCH"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.taskTemplate.title).toBe("Custom schedule name");
    const [, values] = mocks.sql.unsafe.mock.calls[0];
    expect(values).toContainEqual({
      assignedTo: "dev-agent",
      brief: "Updated brief",
    });
    expect(values).not.toContainEqual({
      assignedTo: "dev-agent",
      title: "",
      brief: "Updated brief",
    });
  });

  it("allows an explicit schedule title rename", async () => {
    mocks.sql.mockResolvedValueOnce([{ slug: "dev-agent" }]);
    mocks.sql.unsafe.mockResolvedValueOnce([
      {
        id: "schedule-1",
        hive_id: "hive-1",
        cron_expression: "*/5 * * * *",
        task_template: {
          assignedTo: "dev-agent",
          title: "Renamed schedule",
          brief: "Check work",
          kind: "task",
        },
        enabled: true,
        last_run_at: null,
        next_run_at: null,
        created_by: "scheduler",
        created_at: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);

    const res = await PATCH(request({
      id: "schedule-1",
      taskTemplate: {
        assignedTo: "dev-agent",
        title: "Renamed schedule",
        brief: "Check work",
      },
    }, "PATCH"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.taskTemplate.title).toBe("Renamed schedule");
    const [, values] = mocks.sql.unsafe.mock.calls[0];
    expect(values).toContainEqual({
      assignedTo: "dev-agent",
      title: "Renamed schedule",
      brief: "Check work",
    });
  });

  it("applies mixed schedule updates in one update statement", async () => {
    const taskTemplate = {
      assignedTo: "dev-agent",
      title: "Updated review",
      brief: "Check the new cadence",
      kind: "task",
    };
    mocks.sql.mockResolvedValueOnce([{ slug: "dev-agent" }]);
    mocks.sql.unsafe.mockResolvedValueOnce([
      {
        id: "schedule-1",
        hive_id: "hive-1",
        cron_expression: "0 10 * * 1",
        task_template: taskTemplate,
        enabled: false,
        last_run_at: null,
        next_run_at: new Date("2026-04-27T10:00:00.000Z"),
        created_by: "scheduler",
        created_at: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);

    const res = await PATCH(request({
      id: "schedule-1",
      enabled: false,
      cronExpression: "0 10 * * 1",
      taskTemplate,
    }, "PATCH"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      id: "schedule-1",
      enabled: false,
      cronExpression: "0 10 * * 1",
      taskTemplate,
    });
    expect(mocks.sql).toHaveBeenCalledTimes(1);
    expect(mocks.sql.unsafe).toHaveBeenCalledTimes(1);
    const [query, values] = mocks.sql.unsafe.mock.calls[0];
    expect(query.match(/UPDATE schedules/g)).toHaveLength(1);
    expect(query).toContain("enabled");
    expect(query).toContain("cron_expression");
    expect(query).toContain("next_run_at");
    expect(query).toContain("task_template");
    expect(values).toContain(false);
    expect(values).toContain("0 10 * * 1");
    expect(values).toContainEqual(taskTemplate);
    expect(values.at(-1)).toBe("schedule-1");
  });

  it("allows system owners to create schedules with the existing response shape", async () => {
    const createdAt = new Date("2026-04-27T00:00:00.000Z");
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: "schedule-1",
        hive_id: "hive-1",
        cron_expression: "*/5 * * * *",
        task_template: { title: "Check hive" },
        enabled: true,
        last_run_at: null,
        next_run_at: null,
        created_by: "owner-1",
        created_at: createdAt,
      }]);

    const res = await POST(request({
      hiveId: "hive-1",
      cronExpression: "*/5 * * * *",
      taskTemplate: { title: "Check hive" },
      enabled: true,
      createdBy: "owner-1",
    }, "POST"));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data).toEqual({
      id: "schedule-1",
      hiveId: "hive-1",
      cronExpression: "*/5 * * * *",
      taskTemplate: { title: "Check hive" },
      enabled: true,
      lastRunAt: null,
      nextRunAt: null,
      createdBy: "owner-1",
      createdAt: createdAt.toISOString(),
    });
    expect(mocks.sql.json).toHaveBeenCalledWith({ title: "Check hive" });
  });

  it("rejects creating enabled schedules while the hive is paused", async () => {
    mocks.sql.mockResolvedValueOnce([{
      paused: true,
      reason: "Recovery",
      paused_by: "owner@example.com",
      updated_at: new Date("2026-05-02T06:00:00.000Z"),
      operating_state: "paused",
      schedule_snapshot: [],
    }]);

    const res = await POST(request({
      hiveId: "hive-1",
      cronExpression: "*/5 * * * *",
      taskTemplate: { title: "Check hive" },
      enabled: true,
      createdBy: "owner-1",
    }, "POST"));
    const body = await res.json();

    expect(res.status).toBe(423);
    expect(body.code).toBe("HIVE_CREATION_PAUSED");
    expect(mocks.sql.json).not.toHaveBeenCalled();
  });
});
