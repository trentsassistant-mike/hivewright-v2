import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canMutateHive: vi.fn(),
  emitTaskEvent: vi.fn(),
}));

vi.mock("../../../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../../../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canMutateHive: mocks.canMutateHive,
}));

vi.mock("@/dispatcher/event-emitter", () => ({
  emitTaskEvent: mocks.emitTaskEvent,
}));

import { POST } from "./route";

const params = { params: Promise.resolve({ id: "task-1" }) };

function request(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/tasks/task-1/cancel", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function taskRow(status = "active") {
  return {
    id: "task-1",
    hive_id: "hive-a",
    assigned_to: "dev-agent",
    created_by: "owner",
    status,
    title: "Build widget",
    parent_task_id: null,
    goal_id: "goal-1",
    model_used: null,
    started_at: null,
    completed_at: null,
    created_at: new Date("2026-05-01T00:00:00.000Z"),
    updated_at: new Date("2026-05-01T00:00:00.000Z"),
  };
}

describe("POST /api/tasks/[id]/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.canMutateHive.mockResolvedValue(true);
    mocks.emitTaskEvent.mockResolvedValue(undefined);
  });

  it("rejects unauthenticated callers before resolving the task", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await POST(request(), params);

    expect(res.status).toBe(401);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects callers without mutate access to the task hive", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "viewer-1", email: "viewer@example.com", isSystemOwner: false },
    });
    mocks.sql.mockResolvedValueOnce([taskRow()]);
    mocks.canMutateHive.mockResolvedValueOnce(false);

    const res = await POST(request(), params);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot mutate this hive");
    expect(mocks.canMutateHive).toHaveBeenCalledWith(mocks.sql, "viewer-1", "hive-a");
  });

  it("cancels active tasks and emits a dashboard event", async () => {
    const updated = { ...taskRow("cancelled"), completed_at: new Date("2026-05-01T00:05:00.000Z") };
    mocks.sql.mockResolvedValueOnce([taskRow()]).mockResolvedValueOnce([updated]);

    const res = await POST(request({ reason: "owner revocation" }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.cancelled).toBe(true);
    expect(body.data.task).toMatchObject({
      id: "task-1",
      hiveId: "hive-a",
      status: "cancelled",
      goalId: "goal-1",
      assignedTo: "dev-agent",
    });
    expect(String(mocks.sql.mock.calls[1][0])).toContain("status = 'cancelled'");
    expect(mocks.emitTaskEvent).toHaveBeenCalledWith(mocks.sql, expect.objectContaining({
      type: "task_cancelled",
      taskId: "task-1",
      hiveId: "hive-a",
    }));
  });

  it("rejects completed tasks with 409", async () => {
    mocks.sql.mockResolvedValueOnce([taskRow("completed")]);

    const res = await POST(request(), params);

    expect(res.status).toBe(409);
    expect(mocks.emitTaskEvent).not.toHaveBeenCalled();
  });
});
