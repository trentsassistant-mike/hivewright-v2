import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  fetchLatestSupervisorReport: vi.fn(),
  summarizeSupervisorReport: vi.fn(),
  fetchInitiativeRunSummary: vi.fn(),
  fetchLatestInitiativeRun: vi.fn(),
  summarizeInitiativeRun: vi.fn(),
}));

vi.mock("../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("../supervisor-reports/queries", () => ({
  fetchLatestSupervisorReport: mocks.fetchLatestSupervisorReport,
  summarizeSupervisorReport: mocks.summarizeSupervisorReport,
}));

vi.mock("../initiative-runs/queries", () => ({
  fetchInitiativeRunSummary: mocks.fetchInitiativeRunSummary,
  fetchLatestInitiativeRun: mocks.fetchLatestInitiativeRun,
  summarizeInitiativeRun: mocks.summarizeInitiativeRun,
}));

import { createBriefGetHandler } from "./route";

function createDb() {
  return vi.fn((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("FROM decisions") && query.includes("kind = 'decision'") && query.includes("LIMIT 10")) {
      return Promise.resolve([
        {
          id: "decision-1",
          title: "Owner decision",
          priority: "normal",
          context: "Context",
          created_at: new Date("2026-04-28T00:00:00Z"),
          age_hours: 1,
        },
      ]);
    }
    if (query.includes("pending_quality_feedback")) {
      return Promise.resolve([{ pending_quality_feedback: 5 }]);
    }
    if (query.includes("FROM goals g")) return Promise.resolve([]);
    if (query.includes("FROM tasks t") && query.includes("recentCompletionRows")) return Promise.resolve([]);
    if (query.includes("FROM insights")) return Promise.resolve([]);
    if (query.includes("SELECT cost_cents")) return Promise.resolve([]);
    if (query.includes("FROM hive_ideas")) {
      return Promise.resolve([{ open_ideas_count: 0, last_ideas_review_at: null }]);
    }
    if (query.includes("FROM hive_runtime_locks")) {
      return Promise.resolve([{
        paused: true,
        reason: "Manual recovery",
        paused_by: "owner",
        updated_at: new Date("2026-05-02T00:00:00Z"),
        operating_state: "paused",
        schedule_snapshot: [],
      }]);
    }
    if (query.includes("enabled_schedules") && query.includes("runnable_tasks")) {
      return Promise.resolve([{
        enabled_schedules: "0",
        runnable_tasks: "0",
        pending_decisions: "0",
        unresolvable_tasks: "0",
      }]);
    }
    if (query.includes("FROM hive_models")) return Promise.resolve([]);
    if (query.includes("tasks_completed_24h")) {
      return Promise.resolve([{
        tasks_completed_24h: "0",
        tasks_failed_24h: "0",
        goals_completed_7d: "0",
        unresolvable_tasks: "0",
        expiring_creds: "0",
      }]);
    }
    return Promise.resolve([]);
  });
}

describe("GET /api/brief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.fetchLatestSupervisorReport.mockResolvedValue(null);
    mocks.summarizeSupervisorReport.mockReturnValue(null);
    mocks.fetchLatestInitiativeRun.mockResolvedValue(null);
    mocks.summarizeInitiativeRun.mockReturnValue(null);
    mocks.fetchInitiativeRunSummary.mockResolvedValue({
      windowHours: 168,
      runCount: 0,
      completedRuns: 0,
      failedRuns: 0,
      evaluatedCandidates: 0,
      createdItems: 0,
      suppressedItems: 0,
      runFailures: 0,
      suppressionReasons: [],
    });
  });

  it("splits pending owner decisions from pending quality feedback", async () => {
    const db = createDb();
    const GET = createBriefGetHandler(db as never);

    const res = await GET(new Request(
      "http://localhost/api/brief?hiveId=b6b815ba-5109-4066-8a33-cc5560d3a0e1",
    ));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.flags.pendingDecisions).toBe(1);
    expect(body.data.flags.totalPendingDecisions).toBe(1);
    expect(body.data.flags.pendingQualityFeedback).toBe(5);
    expect(body.data.pendingDecisions).toHaveLength(1);
    expect(body.data.operationLock.resumeReadiness.status).toBe("blocked");
    expect(body.data.operationLock.resumeReadiness.blockers[0].code).toBe("no_enabled_models");
    const queries = db.mock.calls.map((call) => call[0].join("?"));
    expect(queries.find((query) => query.includes("kind = 'decision'") && query.includes("LIMIT 10")))
      .toContain("is_qa_fixture = false");
    expect(queries.find((query) => query.includes("pending_quality_feedback")))
      .toContain("is_qa_fixture = false");
    expect(queries.find((query) => query.includes("pending_quality_feedback")))
      .toContain("COALESCE(options #>> '{lane}', 'owner') = 'owner'");
  });

  it("excludes already triaged unresolvable tasks from active dashboard flags", async () => {
    const db = createDb();
    const GET = createBriefGetHandler(db as never);

    const res = await GET(new Request(
      "http://localhost/api/brief?hiveId=b6b815ba-5109-4066-8a33-cc5560d3a0e1",
    ));
    await res.json();

    const queries = db.mock.calls.map((call) => call[0].join("?"));
    const activityQuery = queries.find((query) => query.includes("tasks_completed_24h"));
    expect(activityQuery).toContain("status = 'unresolvable'");
    expect(activityQuery).toContain("NOT EXISTS");
    expect(activityQuery).toContain("assigned_to = 'doctor'");
    expect(activityQuery).toContain("FROM decisions");
  });
});
