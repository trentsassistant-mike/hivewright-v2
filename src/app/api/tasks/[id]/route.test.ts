import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
}));

import { GET } from "./route";
import { sql } from "../../_lib/db";
import { requireApiUser } from "../../_lib/auth";
import { canAccessHive } from "@/auth/users";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockCanAccessHive = canAccessHive as unknown as ReturnType<typeof vi.fn>;

const params = { params: Promise.resolve({ id: "task-1" }) };

const taskRow = {
  id: "task-1",
  hive_id: "hive-1",
  assigned_to: "dev-agent",
  created_by: "owner",
  status: "pending",
  priority: 1,
  title: "Task",
  brief: "Brief",
  parent_task_id: null,
  goal_id: "goal-1",
  project_id: null,
  sprint_number: null,
  qa_required: false,
  acceptance_criteria: null,
  result_summary: null,
  retry_count: 0,
  doctor_attempts: 0,
  failure_reason: null,
  tokens_input: null,
  tokens_output: null,
  cost_cents: null,
  model_used: null,
  started_at: null,
  completed_at: null,
  created_at: new Date("2026-04-27T00:00:00Z"),
  updated_at: new Date("2026-04-27T00:00:00Z"),
};

describe("GET /api/tasks/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it("rejects unauthenticated callers before DB use", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(new Request("http://localhost/api/tasks/task-1"), params);

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });

  it("rejects callers without access to the owning hive", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockSql.mockResolvedValueOnce([taskRow]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/tasks/task-1"), params);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot access this task");
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
  });

  it("allows hive members to read the task", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mockSql.mockResolvedValueOnce([taskRow]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);
    mockCanAccessHive.mockResolvedValueOnce(true);

    const res = await GET(new Request("http://localhost/api/tasks/task-1"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ id: "task-1", hiveId: "hive-1" });
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "member-1", "hive-1");
  });

  it("includes image work product metadata and a safe download URL", async () => {
    mockSql.mockResolvedValueOnce([taskRow]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([{
      id: "wp-1",
      content: "Generated image artifact",
      summary: "Hero concept",
      artifact_kind: "image",
      mime_type: "image/png",
      width: 1024,
      height: 768,
      model_name: "gpt-image-2",
      model_snapshot: "gpt-image-2-2026-04-21",
      prompt_tokens: 2500,
      output_tokens: 1000,
      cost_cents: 5,
      metadata: { prompt: "honeycomb hero" },
      created_at: new Date("2026-04-27T00:01:00Z"),
    }]);

    const res = await GET(new Request("http://localhost/api/tasks/task-1"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.workProducts).toEqual([
      expect.objectContaining({
        id: "wp-1",
        artifactKind: "image",
        mimeType: "image/png",
        dimensions: { width: 1024, height: 768 },
        model: { name: "gpt-image-2", snapshot: "gpt-image-2-2026-04-21" },
        usage: { promptTokens: 2500, outputTokens: 1000, costCents: 5 },
        metadata: { prompt: "honeycomb hero" },
        downloadUrl: "/api/work-products/wp-1/download",
      }),
    ]);
  });

  it("returns normalized codex empty-output runtimeDiagnostics from diagnostic task_logs", async () => {
    mockSql.mockResolvedValueOnce([taskRow]);
    mockSql.mockResolvedValueOnce([{
      chunk: JSON.stringify({
        kind: "codex_empty_output",
        schemaVersion: 1,
        codexEmptyOutput: true,
        rolloutSignaturePresent: true,
        exitCode: 1,
        effectiveAdapter: "codex",
        adapterOverride: "codex",
        modelSlug: "openai-codex/gpt-5.5",
        modelProviderMismatchDetected: false,
        cwd: "/home/example/hivewrightv2",
        stderrTail: "failed to record rollout items",
        truncated: false,
        terminalEvents: [],
      }),
    }]);
    mockSql.mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/tasks/task-1"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.runtimeDiagnostics.codexEmptyOutput).toEqual({
      codexEmptyOutput: true,
      rolloutSignaturePresent: true,
      exitCode: 1,
      effectiveAdapter: "codex",
      adapterOverride: "codex",
      modelSlug: "openai-codex/gpt-5.5",
      modelProviderMismatchDetected: false,
      cwd: "/home/example/hivewrightv2",
      stderrTail: "failed to record rollout items",
      truncated: false,
    });
  });

  it("returns null codexEmptyOutput diagnostics when no diagnostic row exists", async () => {
    mockSql.mockResolvedValueOnce([taskRow]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/tasks/task-1"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.runtimeDiagnostics.codexEmptyOutput).toBeNull();
  });
});
