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
  fresh_input_tokens: 70,
  cached_input_tokens: 30,
  cached_input_tokens_known: true,
  total_context_tokens: 100,
  estimated_billable_cost_cents: 12,
  tokens_input: null,
  tokens_output: null,
  cost_cents: null,
  model_used: null,
  started_at: null,
  completed_at: null,
  created_at: new Date("2026-04-27T00:00:00Z"),
  updated_at: new Date("2026-04-27T00:00:00Z"),
  usage_details: {
    totalInputTokens: 100,
    freshInputTokens: 70,
    outputTokens: 25,
    cacheReadTokens: 30,
    cacheCreationTokens: 10,
    estimatedBillableCostCents: 12,
    cachedInputTokensKnown: true,
  },
  goal_budget_cents: 1000,
  goal_spent_cents: 1000,
  goal_budget_state: "paused",
  goal_budget_warning_triggered_at: new Date("2026-04-27T00:00:00Z"),
  goal_budget_enforced_at: new Date("2026-04-27T00:00:00Z"),
  goal_budget_enforcement_reason: "Paused by budget",
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
    mockSql.mockResolvedValueOnce([]);
    mockCanAccessHive.mockResolvedValueOnce(true);

    const res = await GET(new Request("http://localhost/api/tasks/task-1"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ id: "task-1", hiveId: "hive-1" });
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "member-1", "hive-1");
  });

  it("returns normalized usage and parent goal budget status", async () => {
    mockSql.mockResolvedValueOnce([taskRow]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/tasks/task-1"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.usage).toEqual({
      promptTokens: 100,
      outputTokens: 25,
      costCents: 12,
      cacheReadTokens: 30,
      cacheCreationTokens: 10,
    });
    expect(body.data.goalBudget).toMatchObject({
      capCents: 1000,
      spentCents: 1000,
      remainingCents: 0,
      percentUsed: 100,
      warning: true,
      paused: true,
      state: "paused",
      reason: "Paused by budget",
    });
  });

  it("includes image work product metadata and a safe download URL", async () => {
    mockSql.mockResolvedValueOnce([taskRow]);
    mockSql.mockResolvedValueOnce([]);
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
        usage_details: {
          totalInputTokens: 2500,
          freshInputTokens: 1500,
          outputTokens: 1000,
          cacheReadTokens: 1000,
          cacheCreationTokens: null,
          estimatedBillableCostCents: 5,
          cachedInputTokensKnown: true,
        },
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
        usage: {
          promptTokens: 2500,
          outputTokens: 1000,
          costCents: 5,
          cacheReadTokens: 1000,
          cacheCreationTokens: null,
        },
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
        cwd: "/workspace/hivewrightv2",
        stderrTail: "failed to record rollout items",
        truncated: false,
        terminalEvents: [],
      }),
    }]);
    mockSql.mockResolvedValueOnce([]);
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
      cwd: "/workspace/hivewrightv2",
      stderrTail: "failed to record rollout items",
      truncated: false,
    });
  });

  it("returns null codexEmptyOutput diagnostics when no diagnostic row exists", async () => {
    mockSql.mockResolvedValueOnce([taskRow]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/tasks/task-1"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.runtimeDiagnostics.codexEmptyOutput).toBeNull();
  });

  it("returns redacted retrieved context provenance from diagnostic task logs", async () => {
    mockSql.mockResolvedValueOnce([taskRow]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([{
      chunk: JSON.stringify({
        kind: "task_context_provenance",
        schemaVersion: 1,
        status: "available",
        entries: [
          {
            sourceClass: "role_memory",
            reference: "role_memory:11111111-1111-1111-1111-111111111111",
            sourceId: "11111111-1111-1111-1111-111111111111",
            content: "secret memory content must be stripped",
          },
          {
            sourceClass: "hive_memory",
            reference: "hive_memory:22222222-2222-2222-2222-222222222222",
            sourceId: "22222222-2222-2222-2222-222222222222",
            category: "operations",
            sourceTaskId: "33333333-3333-3333-3333-333333333333",
          },
        ],
      }),
    }]);
    mockSql.mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/tasks/task-1"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.provenance).toEqual({
      status: "available",
      entries: [
        {
          sourceClass: "role_memory",
          reference: "role_memory:11111111-1111-1111-1111-111111111111",
          sourceId: "11111111-1111-1111-1111-111111111111",
          sourceTaskId: null,
          category: null,
        },
        {
          sourceClass: "hive_memory",
          reference: "hive_memory:22222222-2222-2222-2222-222222222222",
          sourceId: "22222222-2222-2222-2222-222222222222",
          sourceTaskId: "33333333-3333-3333-3333-333333333333",
          category: "operations",
        },
      ],
      disclaimer: expect.stringContaining("not model-internal reasoning"),
    });
    expect(JSON.stringify(body.data.provenance)).not.toContain("secret memory content");
  });

  it("returns an explicit unavailable provenance state when no provenance row exists", async () => {
    mockSql.mockResolvedValueOnce([taskRow]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);
    mockSql.mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/tasks/task-1"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.provenance).toEqual({
      status: "unavailable",
      entries: [],
      disclaimer: expect.stringContaining("not model-internal reasoning"),
    });
  });
});
