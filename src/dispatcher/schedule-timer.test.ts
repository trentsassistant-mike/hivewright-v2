/**
 * Tests for schedule-timer.ts — heartbeat branch.
 *
 * The `hive-supervisor-heartbeat` kind short-circuits to runSupervisor
 * instead of inserting a task row. These tests pin that branch:
 *   1. heartbeat schedules call runSupervisor and do NOT INSERT into tasks
 *   2. normal schedules INSERT into tasks and do NOT call runSupervisor
 *   3. a runSupervisor failure is swallowed so the schedule still advances
 *   4. both branches UPDATE schedules with a new next_run_at (no stuck refires)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Sql } from "postgres";

const runSupervisorMock = vi.fn();
const runIdeasDailyReviewMock = vi.fn();
const runLlmReleaseScanMock = vi.fn();
const runOwnerFeedbackSampleSweepMock = vi.fn();
vi.mock("../supervisor", () => ({
  runSupervisor: runSupervisorMock,
}));
vi.mock("../ideas/daily-review", () => ({
  runIdeasDailyReview: runIdeasDailyReviewMock,
}));
vi.mock("../llm-release-scan", () => ({
  runLlmReleaseScan: runLlmReleaseScanMock,
}));
vi.mock("../quality/owner-feedback-sampler", () => ({
  runOwnerFeedbackSampleSweep: runOwnerFeedbackSampleSweepMock,
}));

import { checkAndFireSchedules } from "./schedule-timer";

type Call = { strings: TemplateStringsArray; values: unknown[] };

/**
 * Builds a postgres.js-compatible template-tag mock. The mock inspects the
 * leading template string to decide what shape to return — the SELECT for
 * due schedules returns `queueRows`, everything else returns [].
 */
function makeSqlMock(queueRows: Record<string, unknown>[]) {
  const calls: Call[] = [];

  const fn = vi.fn((...args: unknown[]) => {
    if (Array.isArray(args[0])) {
      const strings = args[0] as unknown as TemplateStringsArray;
      const values = args.slice(1);
      calls.push({ strings, values });
      const head = strings[0]?.toLowerCase() ?? "";
      if (head.includes("select") && head.includes("from schedules")) {
        return Promise.resolve(queueRows);
      }
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });

  return { sql: fn as unknown as Sql, calls, fn };
}

function queryText(call: Call): string {
  return call.strings.join("?").toLowerCase();
}

const EVERY_15 = "*/15 * * * *";

beforeEach(() => {
  runSupervisorMock.mockReset();
  runIdeasDailyReviewMock.mockReset();
  runLlmReleaseScanMock.mockReset();
  runOwnerFeedbackSampleSweepMock.mockReset();
  runSupervisorMock.mockResolvedValue({
    skipped: true,
    reportId: null,
    findings: 0,
    actionsApplied: 0,
    actionsSkipped: 0,
    actionsErrored: 0,
  });
  runIdeasDailyReviewMock.mockResolvedValue({
    skipped: false,
    openIdeas: 1,
  });
  runLlmReleaseScanMock.mockResolvedValue({
    runId: "release-scan-run-1",
    providersChecked: 6,
    sourcesChecked: 12,
    candidatesEvaluated: 0,
    newModelsDetected: 0,
    decisionsCreated: 0,
    heartbeatRecorded: true,
    candidates: [],
    sourceEvidence: [],
  });
  runOwnerFeedbackSampleSweepMock.mockResolvedValue([
    {
      hiveId: "hive-quality-1",
      eligible: 1,
      sampled: 1,
      decisionsCreated: 1,
    },
  ]);
});

describe("checkAndFireSchedules — hive-supervisor-heartbeat branch", () => {
  it("calls runSupervisor with the hiveId and does NOT insert a task", async () => {
    const { sql, calls } = makeSqlMock([
      {
        id: "sched-1",
        hive_id: "hive-uuid-1",
        cron_expression: EVERY_15,
        task_template: { kind: "hive-supervisor-heartbeat" },
      },
    ]);

    const created = await checkAndFireSchedules(sql);

    expect(created).toBe(1);
    expect(runSupervisorMock).toHaveBeenCalledTimes(1);
    expect(runSupervisorMock).toHaveBeenCalledWith(sql, "hive-uuid-1");

    const insertCalls = calls.filter((c) => queryText(c).includes("insert into tasks"));
    expect(insertCalls).toHaveLength(0);

    const updateCalls = calls.filter((c) => queryText(c).includes("update schedules"));
    expect(updateCalls).toHaveLength(1);
  });

  it("parses task_template when it comes back as a JSON string", async () => {
    const { sql, calls } = makeSqlMock([
      {
        id: "sched-2",
        hive_id: "hive-uuid-2",
        cron_expression: EVERY_15,
        task_template: JSON.stringify({ kind: "hive-supervisor-heartbeat" }),
      },
    ]);

    await checkAndFireSchedules(sql);

    expect(runSupervisorMock).toHaveBeenCalledWith(sql, "hive-uuid-2");
    expect(calls.filter((c) => queryText(c).includes("insert into tasks"))).toHaveLength(0);
  });

  it("falls through to the task-insert path when kind is absent or unknown", async () => {
    const { sql, calls } = makeSqlMock([
      {
        id: "sched-3",
        hive_id: "hive-uuid-3",
        cron_expression: EVERY_15,
        task_template: {
          assignedTo: "dev-agent",
          title: "Do thing",
          brief: "brief",
        },
      },
    ]);

    const created = await checkAndFireSchedules(sql);

    expect(created).toBe(1);
    expect(runSupervisorMock).not.toHaveBeenCalled();
    expect(runIdeasDailyReviewMock).not.toHaveBeenCalled();

    const insertCalls = calls.filter((c) => queryText(c).includes("insert into tasks"));
    expect(insertCalls).toHaveLength(1);

    const updateCalls = calls.filter((c) => queryText(c).includes("update schedules"));
    expect(updateCalls).toHaveLength(1);
  });

  it("swallows a runSupervisor failure and still advances the schedule", async () => {
    runSupervisorMock.mockRejectedValueOnce(new Error("supervisor boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { sql, calls } = makeSqlMock([
      {
        id: "sched-4",
        hive_id: "hive-uuid-4",
        cron_expression: EVERY_15,
        task_template: { kind: "hive-supervisor-heartbeat" },
      },
    ]);

    const created = await checkAndFireSchedules(sql);

    expect(created).toBe(1);
    expect(runSupervisorMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();

    // Schedule must still advance so a stuck hive can't refire every tick.
    const updateCalls = calls.filter((c) => queryText(c).includes("update schedules"));
    expect(updateCalls).toHaveLength(1);

    errorSpy.mockRestore();
  });

  it("calls runIdeasDailyReview for ideas-daily-review schedules and does NOT insert a task", async () => {
    const { sql, calls } = makeSqlMock([
      {
        id: "sched-ideas-1",
        hive_id: "hive-ideas-1",
        cron_expression: "0 9 * * *",
        task_template: { kind: "ideas-daily-review" },
      },
    ]);

    const created = await checkAndFireSchedules(sql);

    expect(created).toBe(1);
    expect(runIdeasDailyReviewMock).toHaveBeenCalledTimes(1);
    expect(runIdeasDailyReviewMock).toHaveBeenCalledWith(sql, "hive-ideas-1");
    expect(runSupervisorMock).not.toHaveBeenCalled();

    const insertCalls = calls.filter((c) => queryText(c).includes("insert into tasks"));
    expect(insertCalls).toHaveLength(0);

    const updateCalls = calls.filter((c) => queryText(c).includes("update schedules"));
    expect(updateCalls).toHaveLength(1);
  });

  it("swallows a runIdeasDailyReview failure and still advances the schedule", async () => {
    runIdeasDailyReviewMock.mockRejectedValueOnce(new Error("ideas boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { sql, calls } = makeSqlMock([
      {
        id: "sched-ideas-2",
        hive_id: "hive-ideas-2",
        cron_expression: "0 9 * * *",
        task_template: { kind: "ideas-daily-review" },
      },
    ]);

    const created = await checkAndFireSchedules(sql);

    expect(created).toBe(1);
    expect(runIdeasDailyReviewMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();

    const updateCalls = calls.filter((c) => queryText(c).includes("update schedules"));
    expect(updateCalls).toHaveLength(1);

    errorSpy.mockRestore();
  });

  it("routes each schedule to the correct branch when mixed rows are due", async () => {
    const { sql, calls } = makeSqlMock([
      {
        id: "sched-a",
        hive_id: "hive-a",
        cron_expression: EVERY_15,
        task_template: { kind: "hive-supervisor-heartbeat" },
      },
      {
        id: "sched-b",
        hive_id: "hive-b",
        cron_expression: EVERY_15,
        task_template: { assignedTo: "dev-agent", title: "t", brief: "b" },
      },
    ]);

    const created = await checkAndFireSchedules(sql);

    expect(created).toBe(2);
    expect(runSupervisorMock).toHaveBeenCalledTimes(1);
    expect(runSupervisorMock).toHaveBeenCalledWith(sql, "hive-a");
    expect(runIdeasDailyReviewMock).not.toHaveBeenCalled();

    const insertCalls = calls.filter((c) => queryText(c).includes("insert into tasks"));
    expect(insertCalls).toHaveLength(1);

    const updateCalls = calls.filter((c) => queryText(c).includes("update schedules"));
    expect(updateCalls).toHaveLength(2);
  });

  it("calls runLlmReleaseScan for llm-release-scan schedules and does NOT insert a task", async () => {
    const { sql, calls } = makeSqlMock([
      {
        id: "sched-llm-1",
        hive_id: "hive-llm-1",
        cron_expression: "0 8 * * 1",
        task_template: { kind: "llm-release-scan" },
      },
    ]);

    const created = await checkAndFireSchedules(sql);

    expect(created).toBe(1);
    expect(runLlmReleaseScanMock).toHaveBeenCalledTimes(1);
    expect(runLlmReleaseScanMock).toHaveBeenCalledWith(sql, {
      hiveId: "hive-llm-1",
      trigger: {
        kind: "schedule",
        scheduleId: "sched-llm-1",
      },
    });
    expect(runSupervisorMock).not.toHaveBeenCalled();
    expect(runIdeasDailyReviewMock).not.toHaveBeenCalled();
    expect(runOwnerFeedbackSampleSweepMock).not.toHaveBeenCalled();

    const insertCalls = calls.filter((c) => queryText(c).includes("insert into tasks"));
    expect(insertCalls).toHaveLength(0);

    const updateCalls = calls.filter((c) => queryText(c).includes("update schedules"));
    expect(updateCalls).toHaveLength(1);
  });

  it("calls runOwnerFeedbackSampleSweep for task-quality-feedback-sample schedules and does NOT insert a task", async () => {
    const { sql, calls } = makeSqlMock([
      {
        id: "sched-quality-1",
        hive_id: "hive-quality-1",
        cron_expression: "0 10 * * *",
        task_template: { kind: "task-quality-feedback-sample" },
      },
    ]);

    const created = await checkAndFireSchedules(sql);

    expect(created).toBe(1);
    expect(runOwnerFeedbackSampleSweepMock).toHaveBeenCalledTimes(1);
    expect(runOwnerFeedbackSampleSweepMock).toHaveBeenCalledWith(sql, {
      hiveId: "hive-quality-1",
    });
    expect(runSupervisorMock).not.toHaveBeenCalled();
    expect(runIdeasDailyReviewMock).not.toHaveBeenCalled();
    expect(runLlmReleaseScanMock).not.toHaveBeenCalled();

    const insertCalls = calls.filter((c) => queryText(c).includes("insert into tasks"));
    expect(insertCalls).toHaveLength(0);

    const updateCalls = calls.filter((c) => queryText(c).includes("update schedules"));
    expect(updateCalls).toHaveLength(1);
  });
});
