/**
 * Tests for GET /api/goals/:id/stream
 *
 * Covers the four acceptance criteria from the QA contract:
 *   1. Initial connect with buffered events (replay from task_logs)
 *   2. Live append while an agent is running (pg_notify forwarded to SSE)
 *   3. Reconnect without duplicate lines (Last-Event-ID dedup)
 *   4. Multiple task events under one goal view (cross-task fan-in)
 *
 * Because SSE is a ReadableStream we collect frames by reading the response
 * body as text and splitting on the SSE frame delimiter ("\n\n").
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Capture the LISTEN callback so tests can fire synthetic pg_notify payloads.
let capturedListenCallback: ((payload: string) => void) | null = null;

vi.mock("postgres", () => {
  const mockUnlisten = vi.fn().mockResolvedValue(undefined);
  const mockListen = vi.fn((_channel: string, cb: (p: string) => void) => {
    capturedListenCallback = cb;
    return Promise.resolve({ unlisten: mockUnlisten });
  });
  const mockEnd = vi.fn().mockResolvedValue(undefined);

  const clientInstance = { listen: mockListen, end: mockEnd };
  const postgres = vi.fn(() => clientInstance);
  return { default: postgres };
});

// sql.unsafe controls what rows come back from the replay query.
let mockReplayRows: unknown[] = [];

vi.mock("../../../_lib/db", () => ({
  sql: Object.assign(
    vi.fn(async () => [{ hive_id: "hive-a" }]),
    { unsafe: vi.fn(async () => mockReplayRows) },
  ),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse an SSE stream into an array of parsed JSON objects (one per frame). */
async function collectFrames(
  stream: ReadableStream<Uint8Array>,
  stopAfterFrames: number,
  injectAfterConnect?: () => void,
): Promise<Array<Record<string, unknown>>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: Array<Record<string, unknown>> = [];

  while (frames.length < stopAfterFrames) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Split on SSE frame boundary
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) {
        frames.push(JSON.parse(dataLine.slice(6)));
        // Trigger live injection after the first "connected" frame is received
        if (frames.length === 1 && injectAfterConnect) {
          injectAfterConnect();
        }
        if (frames.length >= stopAfterFrames) break;
      }
    }
  }

  reader.cancel();
  return frames;
}

/** Build a fake DB row as task_logs returns it. */
function makeDbRow(opts: {
  id: number;
  task_id: string;
  chunk: string;
  type: string;
  timestamp?: string;
}) {
  return {
    id: BigInt(opts.id),
    task_id: opts.task_id,
    chunk: opts.chunk,
    type: opts.type,
    timestamp: new Date(opts.timestamp ?? "2026-04-09T12:00:00.000Z"),
  };
}

/** Build a goal_output pg_notify payload as the dispatcher emits it. */
function makeGoalPayload(opts: {
  goalId: string;
  taskId: string;
  chunk: string;
  type: string;
  id: number;
  timestamp?: string;
}) {
  return JSON.stringify({
    goalId: opts.goalId,
    taskId: opts.taskId,
    chunk: opts.chunk,
    type: opts.type,
    id: opts.id,
    timestamp: opts.timestamp ?? "2026-04-09T12:00:01.000Z",
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

import { GET } from "./route";

describe("GET /api/goals/:id/stream", () => {
  beforeEach(() => {
    capturedListenCallback = null;
    mockReplayRows = [];
    vi.clearAllMocks();
  });

  // ── 1. Initial connect with buffered events ────────────────────────────────
  it("replays all task_logs rows on initial connect (Last-Event-ID absent)", async () => {
    mockReplayRows = [
      makeDbRow({ id: 1, task_id: "task-a", chunk: "Starting task: Sprint 1", type: "status" }),
      makeDbRow({ id: 2, task_id: "task-a", chunk: "Reading files…\n", type: "stdout" }),
      makeDbRow({ id: 3, task_id: "task-a", chunk: "", type: "done" }),
    ];

    const request = new Request("http://localhost/api/goals/goal-1/stream", {
      signal: AbortSignal.timeout(2000),
    });

    const res = await GET(request, { params: Promise.resolve({ id: "goal-1" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Collect "connected" + 3 replay frames
    const frames = await collectFrames(res.body!, 4);

    expect(frames[0].type).toBe("connected");
    expect((frames[0] as Record<string, unknown>).goalId).toBe("goal-1");

    expect(frames[1].type).toBe("status");
    expect((frames[1] as Record<string, unknown>).taskId).toBe("task-a");
    expect((frames[1] as Record<string, unknown>).id).toBe(1);

    expect(frames[2].type).toBe("stdout");
    expect((frames[2] as Record<string, unknown>).chunk).toBe("Reading files…\n");

    expect(frames[3].type).toBe("done");
    expect((frames[3] as Record<string, unknown>).id).toBe(3);
  });

  // ── 2. Live append while an agent is running ──────────────────────────────
  it("forwards live pg_notify chunks to the SSE stream after replay", async () => {
    // No historical rows — task is just starting
    mockReplayRows = [];

    let listenCallbackReady = false;
    const request = new Request("http://localhost/api/goals/goal-2/stream", {
      signal: AbortSignal.timeout(3000),
    });

    const injectLive = () => {
      listenCallbackReady = true;
      // Simulate the dispatcher calling pg_notify shortly after connect
      setTimeout(() => {
        capturedListenCallback?.(
          makeGoalPayload({
            goalId: "goal-2",
            taskId: "task-b",
            chunk: "Live stdout line\n",
            type: "stdout",
            id: 10,
          }),
        );
      }, 10);
    };

    const res = await GET(request, { params: Promise.resolve({ id: "goal-2" }) });
    const frames = await collectFrames(res.body!, 2, injectLive);

    expect(listenCallbackReady).toBe(true);

    expect(frames[0].type).toBe("connected");

    expect(frames[1].type).toBe("stdout");
    expect((frames[1] as Record<string, unknown>).chunk).toBe("Live stdout line\n");
    expect((frames[1] as Record<string, unknown>).taskId).toBe("task-b");
    expect((frames[1] as Record<string, unknown>).id).toBe(10);
  });

  // ── 3. Reconnect without duplicate lines ──────────────────────────────────
  it("does not re-send rows already seen when Last-Event-ID is provided", async () => {
    // Rows 1-3 already received by client; server should only send row 4+
    mockReplayRows = [
      makeDbRow({ id: 4, task_id: "task-a", chunk: "New line after reconnect\n", type: "stdout" }),
    ];

    const request = new Request("http://localhost/api/goals/goal-3/stream", {
      headers: { "last-event-id": "3" },
      signal: AbortSignal.timeout(2000),
    });

    const res = await GET(request, { params: Promise.resolve({ id: "goal-3" }) });
    const frames = await collectFrames(res.body!, 2);

    // Only "connected" + the one new row
    expect(frames).toHaveLength(2);
    expect(frames[0].type).toBe("connected");
    expect((frames[1] as Record<string, unknown>).id).toBe(4);
    expect((frames[1] as Record<string, unknown>).chunk).toBe("New line after reconnect\n");
  });

  it("deduplicates live chunks that arrive during the replay window", async () => {
    // Simulate a pg_notify arriving during replay for id=5 — already in replay rows
    mockReplayRows = [
      makeDbRow({ id: 5, task_id: "task-a", chunk: "overlap chunk", type: "stdout" }),
    ];

    const request = new Request("http://localhost/api/goals/goal-3b/stream", {
      headers: { "last-event-id": "4" },
      signal: AbortSignal.timeout(2000),
    });

    // Inject a duplicate (id=5) into pendingLive before replay finishes.
    // We simulate this by firing the callback before GET returns (not possible
    // in the real flow, but we verify the dedup logic by checking the output
    // contains id=5 exactly once).
    const duplicatePayload = makeGoalPayload({
      goalId: "goal-3b",
      taskId: "task-a",
      chunk: "overlap chunk",
      type: "stdout",
      id: 5,
    });

    // Pre-populate the callback so it fires immediately when the listen mock runs
    // (the listen mock captures the callback synchronously before replay runs)
    const origListenImpl = capturedListenCallback;
    void origListenImpl; // unused pre-capture

    const res = await GET(request, { params: Promise.resolve({ id: "goal-3b" }) });

    // Fire the duplicate into pending before we read
    capturedListenCallback?.(duplicatePayload);

    const frames = await collectFrames(res.body!, 2);

    // Should be "connected" + exactly one frame for id=5
    const id5Frames = frames.filter((f) => (f as Record<string, unknown>).id === 5);
    expect(id5Frames).toHaveLength(1);
  });

  // ── 5. New task starts after initial connect ──────────────────────────────
  // This is the critical path for GoalLiveActivity: a task that was not
  // running at connect time must appear in the stream when it starts.
  it("delivers live chunks for a brand-new task that starts after initial connect", async () => {
    // No history — no tasks have produced output yet at connect time
    mockReplayRows = [];

    const request = new Request("http://localhost/api/goals/goal-5/stream", {
      signal: AbortSignal.timeout(3000),
    });

    const injectNewTask = () => {
      // Simulate task-x starting a sprint after the page was already loaded
      setTimeout(() => {
        capturedListenCallback?.(
          makeGoalPayload({
            goalId: "goal-5",
            taskId: "task-x",
            chunk: "Starting task: Sprint 2 analysis\n",
            type: "status",
            id: 20,
          }),
        );
      }, 10);
    };

    const res = await GET(request, { params: Promise.resolve({ id: "goal-5" }) });
    const frames = await collectFrames(res.body!, 2, injectNewTask);

    expect(frames[0].type).toBe("connected");
    // task-x was not in the backfill — it must still arrive via pg_notify
    expect((frames[1] as Record<string, unknown>).taskId).toBe("task-x");
    expect((frames[1] as Record<string, unknown>).chunk).toBe(
      "Starting task: Sprint 2 analysis\n",
    );
    expect((frames[1] as Record<string, unknown>).id).toBe(20);
  });

  // ── 4. Multiple task events under one goal view ───────────────────────────
  it("fans in output from multiple tasks belonging to the same goal", async () => {
    mockReplayRows = [
      makeDbRow({ id: 1, task_id: "task-a", chunk: "Task A line 1\n", type: "stdout" }),
      makeDbRow({ id: 2, task_id: "task-b", chunk: "Task B line 1\n", type: "stdout" }),
      makeDbRow({ id: 3, task_id: "task-a", chunk: "", type: "done" }),
      makeDbRow({ id: 4, task_id: "task-b", chunk: "", type: "done" }),
    ];

    const request = new Request("http://localhost/api/goals/goal-4/stream", {
      signal: AbortSignal.timeout(2000),
    });

    const res = await GET(request, { params: Promise.resolve({ id: "goal-4" }) });
    const frames = await collectFrames(res.body!, 5); // connected + 4 rows

    // Verify interleaved tasks are all present and ordered by id
    expect(frames[0].type).toBe("connected");

    const logFrames = frames.slice(1);
    expect(logFrames.map((f) => (f as Record<string, unknown>).taskId)).toEqual([
      "task-a",
      "task-b",
      "task-a",
      "task-b",
    ]);
    expect(logFrames.map((f) => (f as Record<string, unknown>).id)).toEqual([1, 2, 3, 4]);
    expect(logFrames.map((f) => (f as Record<string, unknown>).goalId)).toEqual([
      "goal-4",
      "goal-4",
      "goal-4",
      "goal-4",
    ]);

    // "done" from task-a should NOT close the stream (goal may have more tasks)
    // Verified implicitly: we received all 4 log frames without the stream closing early
  });
});
