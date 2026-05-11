import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
  loadAgentObservability: vi.fn(),
}));

vi.mock("../../../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../../../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

vi.mock("@/agents/observability", () => ({
  loadAgentObservability: mocks.loadAgentObservability,
}));

import { GET } from "./route";

describe("GET /api/roles/[slug]/observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_OBSERVABILITY_PANEL;
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it("returns the sanitized role observability model for a system owner", async () => {
    mocks.loadAgentObservability.mockResolvedValueOnce({
      role: { slug: "dev-agent", name: "Developer Agent", department: "engineering", type: "executor" },
      scope: { hiveId: "hive-1" },
      history: {
        agentLevel: { historyLevel: "agent", totalRuns: 1, statusCounts: { completed: 1 }, lastRunAt: "2026-05-11T00:00:00.000Z" },
        taskLevel: [
          {
            historyLevel: "task",
            id: "task-1",
            title: "Observed task",
            status: "completed",
            createdAt: "2026-05-11T00:00:00.000Z",
            startedAt: "2026-05-11T00:01:00.000Z",
            completedAt: "2026-05-11T00:05:00.000Z",
            parentTaskId: null,
            goalId: "goal-1",
            createdBy: "scheduler",
            modelUsed: "openai-codex/gpt-5.5",
          },
        ],
        emptyMessage: null,
      },
      scheduleState: {
        kind: "scheduled",
        label: "1 schedule",
        message: null,
        schedules: [
          {
            id: "schedule-1",
            cronExpression: "0 9 * * *",
            enabled: true,
            lastRunAt: "2026-05-10T23:00:00.000Z",
            nextRunAt: "2026-05-11T23:00:00.000Z",
            kind: "daily",
            title: "Daily research",
          },
        ],
      },
      tools: [{ slug: "github", label: "GitHub", source: "role-mcp" }],
      toolsEmptyMessage: null,
      connectedApps: [{ id: "install-1", connectorSlug: "github", displayName: "Owner GitHub", status: "active" }],
      connectedAppsEmptyMessage: null,
      memory: {
        roleMemory: [{ id: "mem-1", sourceTaskId: "task-1", confidence: 0.9, sensitivity: "internal", createdAt: "2026-05-11T00:00:00.000Z", updatedAt: "2026-05-11T00:00:00.000Z" }],
        hiveMemory: [],
        emptyMessage: null,
      },
      files: {
        attachments: [],
        workProducts: [{ id: "wp-1", taskId: "task-1", artifactKind: "report", fileLabel: "report.md", mimeType: "text/markdown", sensitivity: "internal", createdAt: "2026-05-11T00:06:00.000Z" }],
        emptyMessage: null,
      },
    });

    const res = await GET(
      new Request("http://localhost/api/roles/dev-agent/observability?hiveId=hive-1"),
      { params: Promise.resolve({ slug: "dev-agent" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.loadAgentObservability).toHaveBeenCalledWith(mocks.sql, "dev-agent", { hiveId: "hive-1" });
    expect(body.data.history.agentLevel.historyLevel).toBe("agent");
    expect(body.data.history.taskLevel[0].historyLevel).toBe("task");
    expect(JSON.stringify(body)).not.toMatch(/credential|token|raw private/i);
  });

  it("enforces hive access for non-owner callers", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(
      new Request("http://localhost/api/roles/dev-agent/observability?hiveId=hive-other"),
      { params: Promise.resolve({ slug: "dev-agent" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toContain("Forbidden");
    expect(mocks.loadAgentObservability).not.toHaveBeenCalled();
  });

  it("requires a hive scope for non-owner callers", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });

    const res = await GET(
      new Request("http://localhost/api/roles/dev-agent/observability"),
      { params: Promise.resolve({ slug: "dev-agent" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("hiveId is required");
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.loadAgentObservability).not.toHaveBeenCalled();
  });
});
