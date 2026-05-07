/**
 * Tests for task-log-writer.ts
 *
 * Covers:
 *   1. writeTaskLog inserts a row and fires task_output pg_notify
 *   2. writeTaskLog fires goal_output pg_notify when goalId is provided
 *   3. writeTaskLog does NOT fire goal_output when goalId is absent
 *   4. pg_notify payload truncates chunk to 7000 chars; DB INSERT is untruncated
 */

import { describe, it, expect, vi } from "vitest";
import { writeTaskLog } from "./task-log-writer";
import type { Sql } from "postgres";

/** Build a minimal sql mock that tracks calls and returns canned row data. */
function makeSqlMock(rowOverrides: Record<string, unknown> = {}) {
  const calls: Array<{ strings: TemplateStringsArray | string; values: unknown[] }> = [];

  const mock = vi.fn((...args: unknown[]) => {
    // Template-tag call: sql`...`
    if (Array.isArray(args[0])) {
      const strings = args[0] as unknown as TemplateStringsArray;
      const values = args.slice(1);
      calls.push({ strings, values });
      // Return a row for the INSERT call; empty array for pg_notify SELECTs
      const query = strings.join("?").toLowerCase();
      if (query.includes("insert")) {
        return Promise.resolve([{ id: BigInt(42), timestamp: new Date("2026-04-09T12:00:00.000Z"), ...rowOverrides }]);
      }
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;

  // postgres.js also exposes sql.unsafe() — mock it so the route tests can use it
  (mock as unknown as Record<string, unknown>).unsafe = vi.fn(() => Promise.resolve([]));

  return { mock, calls };
}

describe("writeTaskLog", () => {
  it("inserts a row and returns the written chunk with id and timestamp", async () => {
    const { mock } = makeSqlMock();

    const result = await writeTaskLog(mock, {
      taskId: "task-uuid-1",
      chunk: "hello world",
      type: "stdout",
    });

    expect(result.id).toBe(42);
    expect(result.timestamp).toBe("2026-04-09T12:00:00.000Z");
    expect(result.taskId).toBe("task-uuid-1");
    expect(result.chunk).toBe("hello world");
    expect(result.type).toBe("stdout");
  });

  it("fires pg_notify on task_output:<taskId>", async () => {
    const { mock } = makeSqlMock();

    await writeTaskLog(mock, {
      taskId: "task-uuid-1",
      chunk: "some output",
      type: "stdout",
    });

    // Find the pg_notify call for task_output
    const calls = (mock as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const taskNotifyCall = calls.find((c: unknown[]) => {
      const strings = c[0] as TemplateStringsArray;
      return Array.isArray(strings) && strings.join("").includes("pg_notify");
    });
    expect(taskNotifyCall).toBeDefined();

    // The channel argument should contain task_output:task-uuid-1
    const channelArg = taskNotifyCall![1] as string;
    expect(channelArg).toBe("task_output:task-uuid-1");

    // The payload argument should be valid JSON with the correct shape
    const payloadArg = taskNotifyCall![2] as string;
    const payload = JSON.parse(payloadArg);
    expect(payload.taskId).toBe("task-uuid-1");
    expect(payload.chunk).toBe("some output");
    expect(payload.type).toBe("stdout");
    expect(payload.id).toBe(42);
    expect(payload.timestamp).toBe("2026-04-09T12:00:00.000Z");
  });

  it("fires pg_notify on goal_output:<goalId> when goalId is provided", async () => {
    const { mock } = makeSqlMock();

    await writeTaskLog(mock, {
      taskId: "task-uuid-1",
      goalId: "goal-uuid-9",
      chunk: "agent step",
      type: "stdout",
    });

    const calls = (mock as unknown as ReturnType<typeof vi.fn>).mock.calls;

    // Find the pg_notify call that uses goal_output channel
    const goalNotifyCall = calls.find((c: unknown[]) => {
      const strings = c[0] as TemplateStringsArray;
      if (!Array.isArray(strings)) return false;
      // The first value arg after the template tag contains the channel name
      const channelArg = c[1] as string;
      return typeof channelArg === "string" && channelArg.startsWith("goal_output:");
    });
    expect(goalNotifyCall).toBeDefined();

    const channelArg = goalNotifyCall![1] as string;
    expect(channelArg).toBe("goal_output:goal-uuid-9");

    const payloadArg = goalNotifyCall![2] as string;
    const payload = JSON.parse(payloadArg);
    expect(payload.goalId).toBe("goal-uuid-9");
    expect(payload.taskId).toBe("task-uuid-1");
    expect(payload.chunk).toBe("agent step");
    expect(payload.type).toBe("stdout");
    expect(payload.id).toBe(42);
  });

  it("does NOT fire goal_output when goalId is absent", async () => {
    const { mock } = makeSqlMock();

    await writeTaskLog(mock, {
      taskId: "task-uuid-1",
      chunk: "no goal",
      type: "stderr",
    });

    const calls = (mock as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const goalNotifyCall = calls.find((c: unknown[]) => {
      const channelArg = c[1] as string;
      return typeof channelArg === "string" && channelArg.startsWith("goal_output:");
    });
    expect(goalNotifyCall).toBeUndefined();
  });

  it("truncates chunk to 7000 chars in pg_notify payload but stores full text in DB", async () => {
    const { mock } = makeSqlMock();

    const longChunk = "x".repeat(10_000);
    await writeTaskLog(mock, {
      taskId: "task-uuid-1",
      goalId: "goal-uuid-9",
      chunk: longChunk,
      type: "stdout",
    });

    const calls = (mock as unknown as ReturnType<typeof vi.fn>).mock.calls;

    // The INSERT call should contain the full 10_000-char chunk
    const insertCall = calls.find((c: unknown[]) => {
      const strings = c[0] as TemplateStringsArray;
      return Array.isArray(strings) && strings.join("").toLowerCase().includes("insert");
    });
    expect(insertCall).toBeDefined();
    const insertChunkArg = insertCall![2] as string; // third arg is the chunk value
    expect(insertChunkArg.length).toBe(10_000);

    // Both pg_notify calls should truncate to 7000 chars
    const notifyCalls = calls.filter((c: unknown[]) => {
      const strings = c[0] as TemplateStringsArray;
      if (!Array.isArray(strings)) return false;
      const channelArg = c[1] as string;
      return typeof channelArg === "string" &&
        (channelArg.startsWith("task_output:") || channelArg.startsWith("goal_output:"));
    });
    expect(notifyCalls.length).toBe(2); // one for task, one for goal

    for (const call of notifyCalls) {
      const payload = JSON.parse(call[2] as string);
      expect(payload.chunk.length).toBe(7000);
    }
  });

  it("writes diagnostic task log chunks and broadcasts the standard envelope", async () => {
    const { mock } = makeSqlMock();
    const diagnostic = JSON.stringify({
      kind: "codex_empty_output",
      schemaVersion: 1,
      codexEmptyOutput: true,
    });

    const result = await writeTaskLog(mock, {
      taskId: "task-uuid-1",
      chunk: diagnostic,
      type: "diagnostic",
    });

    expect(result.type).toBe("diagnostic");
    const calls = (mock as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const insertCall = calls.find((c: unknown[]) => {
      const strings = c[0] as TemplateStringsArray;
      return Array.isArray(strings) && strings.join("").toLowerCase().includes("insert");
    });
    expect(insertCall?.[3]).toBe("diagnostic");

    const notifyCall = calls.find((c: unknown[]) => {
      const strings = c[0] as TemplateStringsArray;
      return Array.isArray(strings) && strings.join("").includes("pg_notify");
    });
    const payload = JSON.parse(notifyCall![2] as string);
    expect(payload).toMatchObject({
      taskId: "task-uuid-1",
      chunk: diagnostic,
      type: "diagnostic",
      id: 42,
      timestamp: "2026-04-09T12:00:00.000Z",
    });
  });
});
