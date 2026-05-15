import { describe, expect, it, vi } from "vitest";
import { getHiveResumeReadiness, type ModelReadinessChecker } from "./resume-readiness";

const HIVE_ID = "b6b815ba-5109-4066-8a33-cc5560d3a0e1";

function createDb(input: {
  paused?: boolean;
  counts?: Partial<{
    enabled_schedules: string | number;
    runnable_tasks: string | number;
    pending_decisions: string | number;
    unresolvable_tasks: string | number;
  }>;
  models?: Array<{ provider: string; adapter_type: string; model_id: string }>;
}) {
  return vi.fn((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("FROM hive_runtime_locks")) {
      return Promise.resolve(input.paused === false ? [] : [{
        paused: input.paused ?? true,
        reason: "Manual recovery",
        paused_by: "owner",
        updated_at: new Date("2026-05-02T00:00:00Z"),
        operating_state: "paused",
        schedule_snapshot: [],
      }]);
    }
    if (query.includes("enabled_schedules") && query.includes("runnable_tasks")) {
      return Promise.resolve([{ 
        enabled_schedules: input.counts?.enabled_schedules ?? 0,
        runnable_tasks: input.counts?.runnable_tasks ?? 0,
        pending_decisions: input.counts?.pending_decisions ?? 0,
        unresolvable_tasks: input.counts?.unresolvable_tasks ?? 0,
      }]);
    }
    if (query.includes("FROM hive_models")) {
      return Promise.resolve(input.models ?? []);
    }
    return Promise.resolve([]);
  });
}

describe("getHiveResumeReadiness", () => {
  it("reports ready when the hive is paused, no work is queued, and all enabled models have fresh probes", async () => {
    const db = createDb({
      models: [
        { provider: "openai", adapter_type: "codex", model_id: "gpt-5.5" },
        { provider: "google", adapter_type: "gemini", model_id: "gemini-3.1-pro" },
      ],
    });
    const checker: ModelReadinessChecker = vi.fn(async () => ({
      canRun: true,
      reason: "fresh_healthy_probe" as const,
      status: "healthy",
      lastProbedAt: new Date("2026-05-02T00:00:00Z"),
      nextProbeAt: new Date("2026-05-02T01:00:00Z"),
    }));

    const readiness = await getHiveResumeReadiness(db as never, {
      hiveId: HIVE_ID,
      checkModelHealth: checker,
      now: new Date("2026-05-02T00:30:00Z"),
    });

    expect(readiness.status).toBe("ready");
    expect(readiness.canResumeSafely).toBe(true);
    expect(readiness.blockers).toEqual([]);
    expect(readiness.models.ready).toBe(2);
    expect(readiness.models.blocked).toBe(0);
    expect(readiness.sessions).toEqual({
      persistentRoutes: 1,
      fallbackRoutes: 1,
      routes: [
        {
          provider: "openai",
          adapterType: "codex",
          modelId: "gpt-5.5",
          persistentSessions: true,
        },
        {
          provider: "google",
          adapterType: "gemini",
          modelId: "gemini-3.1-pro",
          persistentSessions: false,
        },
      ],
    });
    expect(checker).toHaveBeenCalledTimes(2);
  });

  it("blocks resume when work is already queued, decisions are pending, or no model route has fresh healthy probe evidence", async () => {
    const db = createDb({
      counts: { runnable_tasks: 3, pending_decisions: 1, unresolvable_tasks: 8 },
      models: [
        { provider: "openai", adapter_type: "codex", model_id: "gpt-5.5" },
        { provider: "moonshot", adapter_type: "openai-compatible", model_id: "kimi-2.6" },
      ],
    });
    const checker: ModelReadinessChecker = vi.fn(async () => ({
      canRun: false,
      reason: "health_probe_missing" as const,
      status: "unknown",
      failureReason: "No probe row yet",
    }));

    const readiness = await getHiveResumeReadiness(db as never, {
      hiveId: HIVE_ID,
      checkModelHealth: checker,
    });

    expect(readiness.status).toBe("blocked");
    expect(readiness.canResumeSafely).toBe(false);
    expect(readiness.blockers.map((b) => b.code)).toEqual([
      "runnable_tasks",
      "pending_decisions",
      "model_health_blocked",
    ]);
    expect(readiness.models.ready).toBe(0);
    expect(readiness.models.blocked).toBe(2);
    expect(readiness.models.blockedRoutes[1]).toMatchObject({
      provider: "moonshot",
      adapterType: "openai-compatible",
      modelId: "kimi-2.6",
      reason: "health_probe_missing",
    });
  });

  it("does not block resume for stale fallback routes when at least one model is runnable", async () => {
    const db = createDb({
      models: [
        { provider: "openai", adapter_type: "codex", model_id: "gpt-5.5" },
        { provider: "moonshot", adapter_type: "openai-compatible", model_id: "kimi-2.6" },
      ],
    });
    const checker: ModelReadinessChecker = vi.fn(async (_sql, input) => {
      if (input.modelId === "gpt-5.5") {
        return {
          canRun: true,
          reason: "fresh_healthy_probe" as const,
          status: "healthy",
          failureReason: null,
        };
      }
      return {
        canRun: false,
        reason: "health_probe_stale" as const,
        status: "healthy",
        failureReason: null,
      };
    });

    const readiness = await getHiveResumeReadiness(db as never, {
      hiveId: HIVE_ID,
      checkModelHealth: checker,
    });

    expect(readiness.status).toBe("ready");
    expect(readiness.canResumeSafely).toBe(true);
    expect(readiness.blockers.map((b) => b.code)).not.toContain("model_health_blocked");
    expect(readiness.models.ready).toBe(1);
    expect(readiness.models.blocked).toBe(1);
  });

  it("counts only active untriaged unresolvable tasks in resume readiness", async () => {
    const db = createDb({ counts: { unresolvable_tasks: 2 } });

    const readiness = await getHiveResumeReadiness(db as never, {
      hiveId: HIVE_ID,
      checkModelHealth: vi.fn(),
    });

    expect(readiness.counts.unresolvableTasks).toBe(2);
    const countQuery = db.mock.calls
      .map((call) => call[0].join("?"))
      .find((query) => query.includes("unresolvable_tasks"));
    expect(countQuery).toContain("NOT EXISTS");
    expect(countQuery).toContain("assigned_to = 'doctor'");
    expect(countQuery).toContain("FROM decisions");
  });

  it("reports running when the hive is not paused", async () => {
    const db = createDb({ paused: false });

    const readiness = await getHiveResumeReadiness(db as never, {
      hiveId: HIVE_ID,
      checkModelHealth: vi.fn(),
    });

    expect(readiness.status).toBe("running");
    expect(readiness.canResumeSafely).toBe(false);
    expect(readiness.blockers).toEqual([]);
  });
});
