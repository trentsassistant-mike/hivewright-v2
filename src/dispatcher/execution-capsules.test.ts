import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildQaReworkPrompt,
  findReusableExecutionCapsule,
  markCapsuleCompleted,
  markCapsuleQaFailed,
  upsertExecutionCapsule,
} from "./execution-capsules";

const sql = vi.fn();

describe("execution capsules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a reusable capsule only when it has an open session for the same adapter", async () => {
    sql.mockResolvedValueOnce([{
      id: "cap-1",
      task_id: "task-1",
      adapter_type: "codex",
      model: "gpt-5.5",
      session_id: "thread-1",
      status: "qa_failed",
      rework_count: 1,
      last_qa_feedback: "Missing tests",
    }]);

    const capsule = await findReusableExecutionCapsule(sql as never, {
      taskId: "task-1",
      adapterType: "codex",
    });

    expect(capsule).toMatchObject({
      id: "cap-1",
      taskId: "task-1",
      adapterType: "codex",
      sessionId: "thread-1",
      reworkCount: 1,
      lastQaFeedback: "Missing tests",
    });
  });

  it("does not reuse capsules without a session id", async () => {
    sql.mockResolvedValueOnce([{ session_id: null }]);

    const capsule = await findReusableExecutionCapsule(sql as never, {
      taskId: "task-1",
      adapterType: "codex",
    });

    expect(capsule).toBeNull();
  });

  it("records QA failure without creating a new task", async () => {
    sql.mockResolvedValueOnce([]);

    await markCapsuleQaFailed(sql as never, {
      taskId: "task-1",
      feedback: "Missing tests",
    });

    expect(String(sql.mock.calls[0][0])).toContain("UPDATE task_execution_capsules");
    expect(String(sql.mock.calls[0][0])).toContain("status = 'qa_failed'");
  });

  it("marks the capsule completed when QA passes", async () => {
    sql.mockResolvedValueOnce([]);

    await markCapsuleCompleted(sql as never, "task-1");

    expect(String(sql.mock.calls[0][0])).toContain("UPDATE task_execution_capsules");
    expect(String(sql.mock.calls[0][0])).toContain("status = 'completed'");
  });

  it("upserts the latest execution metadata", async () => {
    sql.mockResolvedValueOnce([]);

    await upsertExecutionCapsule(sql as never, {
      taskId: "task-1",
      hiveId: "hive-1",
      adapterType: "codex",
      model: "gpt-5.5",
      sessionId: "thread-1",
      lastOutput: "implemented",
      fallbackReason: null,
    });

    const query = String(sql.mock.calls[0][0]);
    expect(query).toContain("INSERT INTO task_execution_capsules");
    expect(query).toContain("ON CONFLICT (task_id)");
  });

  it("builds a compact QA rework prompt with task context and acceptance criteria", () => {
    const prompt = buildQaReworkPrompt({
      title: "Implement billing export",
      brief: "Add a CSV export for invoices.",
      acceptanceCriteria: "Exports include invoice id and total.",
      feedback: "Missing totals column.",
    });

    expect(prompt).toContain("## QA Rework Required");
    expect(prompt).toContain("Task: Implement billing export");
    expect(prompt).toContain("Add a CSV export for invoices.");
    expect(prompt).toContain("Exports include invoice id and total.");
    expect(prompt).toContain("Missing totals column.");
    expect(prompt).not.toContain("undefined");
  });
});
