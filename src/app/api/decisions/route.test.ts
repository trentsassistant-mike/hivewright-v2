import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const unsafe = vi.fn();
  const sql = Object.assign(vi.fn(), { unsafe, json: vi.fn((value: unknown) => value) });
  return {
    sql,
    requireApiUser: vi.fn(),
    enforceInternalTaskHiveScope: vi.fn(),
    canAccessHive: vi.fn(),
    maybeRecordEaHiveSwitch: vi.fn(),
    recordAgentAuditEventBestEffort: vi.fn(),
  };
});

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
  enforceInternalTaskHiveScope: mocks.enforceInternalTaskHiveScope,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

vi.mock("@/ea/native/hive-switch-audit", () => ({
  maybeRecordEaHiveSwitch: mocks.maybeRecordEaHiveSwitch,
}));

vi.mock("@/audit/agent-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/audit/agent-events")>();
  return {
    ...actual,
    recordAgentAuditEventBestEffort: mocks.recordAgentAuditEventBestEffort,
  };
});

import { GET, POST } from "./route";

describe("GET /api/decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "owner@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.enforceInternalTaskHiveScope.mockResolvedValue({ ok: true });
    mocks.recordAgentAuditEventBestEffort.mockResolvedValue(undefined);
  });

  it("lists task quality feedback only when explicitly included", async () => {
    mocks.sql.unsafe
      .mockResolvedValueOnce([{ total: "1" }])
      .mockResolvedValueOnce([
        {
          id: "decision-1",
          hive_id: "hive-1",
          goal_id: null,
          task_id: "task-1",
          title: "Task quality check: Example",
          context: "Context",
          recommendation: "Rate it",
          options: { kind: "task_quality_feedback" },
          priority: "normal",
          status: "pending",
          kind: "task_quality_feedback",
          owner_response: null,
          selected_option_key: null,
          selected_option_label: null,
          ea_attempts: 0,
          ea_reasoning: null,
          ea_decided_at: null,
          created_at: new Date("2026-04-28T01:00:00Z"),
          resolved_at: null,
          task_title: "Example task",
          task_role: "dev-agent",
          task_completed_at: new Date("2026-04-28T00:00:00Z"),
          is_qa_fixture: false,
        },
      ]);

    const res = await GET(new Request(
      "http://localhost/api/decisions?hiveId=hive-1&status=pending&includeKinds=task_quality_feedback",
    ));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.data[0]).toMatchObject({
      id: "decision-1",
      kind: "task_quality_feedback",
      isQaFixture: false,
      task: { id: "task-1", title: "Example task", role: "dev-agent" },
    });
    expect(mocks.sql.unsafe.mock.calls[0][0]).toContain("d.kind = ANY");
    expect(mocks.sql.unsafe.mock.calls[0][0]).toContain("d.is_qa_fixture = false");
    expect(mocks.sql.unsafe.mock.calls[0][0]).toContain("COALESCE(d.options #>> '{lane}', 'owner') = 'owner'");
    expect(mocks.sql.unsafe.mock.calls[0][1]).toEqual([
      "hive-1",
      "pending",
      ["task_quality_feedback"],
    ]);
  });

  it("keeps the default decisions list scoped to kind=decision", async () => {
    mocks.sql.unsafe
      .mockResolvedValueOnce([{ total: "0" }])
      .mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/decisions?hiveId=hive-1&status=pending"));

    expect(res.status).toBe(200);
    expect(mocks.sql.unsafe.mock.calls[0][0]).toContain("d.kind = $3");
    expect(mocks.sql.unsafe.mock.calls[0][0]).toContain("d.is_qa_fixture = false");
    expect(mocks.sql.unsafe.mock.calls[0][1]).toEqual(["hive-1", "pending", "decision"]);
  });

  it("rejects callers without access to the requested hive", async () => {
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/decisions?hiveId=hive-2&status=pending"));

    expect(res.status).toBe(403);
    expect(mocks.sql.unsafe).not.toHaveBeenCalled();
  });
});

describe("POST /api/decisions action-log audit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.enforceInternalTaskHiveScope.mockResolvedValue({ ok: true });
    mocks.recordAgentAuditEventBestEffort.mockResolvedValue(undefined);
  });

  it("emits a decision.created event without copying decision prompt content", async () => {
    const createdAt = new Date("2026-05-01T00:00:00Z");
    mocks.sql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ hiveId: "hive-1" }])
      .mockResolvedValueOnce([{
        root_task_id: "task-1",
        doctor_task_count: 0,
        open_recovery_decision_count: 0,
        replacement_task_count: 0,
      }])
      .mockResolvedValueOnce([{
        id: "decision-1",
        hive_id: "hive-1",
        goal_id: "goal-1",
        task_id: "task-1",
        title: "Sensitive owner question",
        context: "Full raw decision prompt that must not be logged",
        recommendation: null,
        options: [{ label: "Approve" }, { label: "Reject" }],
        priority: "high",
        status: "ea_review",
        kind: "decision",
        owner_response: null,
        selected_option_key: null,
        selected_option_label: null,
        ea_attempts: 0,
        ea_reasoning: null,
        ea_decided_at: null,
        created_at: createdAt,
        resolved_at: null,
        is_qa_fixture: false,
      }])
      .mockResolvedValueOnce([]);

    const res = await POST(new Request("http://localhost/api/decisions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-1" },
      body: JSON.stringify({
        hiveId: "hive-1",
        taskId: "task-1",
        goalId: "goal-1",
        question: "Sensitive owner question",
        context: "Full raw decision prompt that must not be logged",
        options: [{ label: "Approve" }, { label: "Reject" }],
        priority: "high",
      }),
    }));

    expect(res.status).toBe(201);
    expect(mocks.recordAgentAuditEventBestEffort).toHaveBeenCalledWith(
      mocks.sql,
      expect.objectContaining({
        eventType: "decision.created",
        actor: { type: "owner", id: "owner-1", label: "owner@example.com" },
        hiveId: "hive-1",
        goalId: "goal-1",
        taskId: "task-1",
        targetType: "decision",
        targetId: "decision-1",
        requestId: "req-1",
        metadata: expect.objectContaining({
          decisionId: "decision-1",
          kind: "decision",
          priority: "high",
          status: "ea_review",
          optionCount: 2,
          taskBlocked: true,
        }),
      }),
    );
    const auditPayload = mocks.recordAgentAuditEventBestEffort.mock.calls[0]?.[1] as {
      metadata?: Record<string, unknown>;
    };
    expect(JSON.stringify(auditPayload.metadata)).not.toContain("Full raw decision prompt");
    expect(JSON.stringify(auditPayload.metadata)).not.toContain("Sensitive owner question");
  });
});
