/**
 * Tests for GET /api/tasks/:id/stream
 *
 * Covers the four acceptance criteria from the QA contract:
 *   1. Initial connect with buffered events (replay from task_logs)
 *   2. Live append while an agent is running (pg_notify forwarded to SSE)
 *   3. Reconnect without duplicate lines (Last-Event-ID dedup)
 *   4. Stream auto-closes after the terminal "done" event
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

  reader.releaseLock();
  return frames;
}

/**
 * Collect frames until the stream closes naturally (reader.done === true).
 * Useful for verifying auto-close after "done" event.
 */
async function collectAllFrames(
  stream: ReadableStream<Uint8Array>,
): Promise<Array<Record<string, unknown>>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: Array<Record<string, unknown>> = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) {
        frames.push(JSON.parse(dataLine.slice(6)));
      }
    }
  }

  return frames;
}

/** Build a fake DB row as task_logs returns it. */
function makeDbRow(opts: {
  id: number;
  chunk: string;
  type: string;
  timestamp?: string;
}) {
  return {
    id: BigInt(opts.id),
    chunk: opts.chunk,
    type: opts.type,
    timestamp: new Date(opts.timestamp ?? "2026-04-09T12:00:00.000Z"),
  };
}

/** Build a task_output pg_notify payload as the dispatcher emits it. */
function makeTaskPayload(opts: {
  taskId: string;
  chunk: string;
  type: string;
  id: number;
  timestamp?: string;
}) {
  return JSON.stringify({
    taskId: opts.taskId,
    chunk: opts.chunk,
    type: opts.type,
    id: opts.id,
    timestamp: opts.timestamp ?? "2026-04-09T12:00:01.000Z",
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

import { GET } from "./route";

describe("GET /api/tasks/:id/stream", () => {
  beforeEach(() => {
    capturedListenCallback = null;
    mockReplayRows = [];
    vi.clearAllMocks();
  });

  // ── 1. Initial connect with backfill ─────────────────────────────────────
  it("replays all task_logs rows on initial connect (Last-Event-ID absent)", async () => {
    mockReplayRows = [
      makeDbRow({ id: 1, chunk: "Starting…", type: "status" }),
      makeDbRow({ id: 2, chunk: "stdout line\n", type: "stdout" }),
      makeDbRow({ id: 3, chunk: "", type: "done" }),
    ];

    const request = new Request("http://localhost/api/tasks/task-1/stream", {
      signal: AbortSignal.timeout(2000),
    });

    const res = await GET(request, { params: Promise.resolve({ id: "task-1" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Stream auto-closes after "done" — collect all frames until closed.
    const frames = await collectAllFrames(res.body!);

    // "connected" + 3 replay frames
    expect(frames).toHaveLength(4);
    expect(frames[0].type).toBe("connected");
    expect((frames[0] as Record<string, unknown>).taskId).toBe("task-1");

    expect(frames[1].type).toBe("status");
    expect((frames[1] as Record<string, unknown>).id).toBe(1);
    expect((frames[1] as Record<string, unknown>).taskId).toBe("task-1");

    expect(frames[2].type).toBe("stdout");
    expect((frames[2] as Record<string, unknown>).chunk).toBe("stdout line\n");
    expect((frames[2] as Record<string, unknown>).id).toBe(2);

    expect(frames[3].type).toBe("done");
    expect((frames[3] as Record<string, unknown>).id).toBe(3);
  });

  // ── 2. Live append while an agent is running ──────────────────────────────
  it("forwards live pg_notify chunks to the SSE stream after replay", async () => {
    // No historical rows — agent is just starting
    mockReplayRows = [];

    let listenCallbackReady = false;
    const request = new Request("http://localhost/api/tasks/task-2/stream", {
      signal: AbortSignal.timeout(3000),
    });

    const injectLive = () => {
      listenCallbackReady = true;
      setTimeout(() => {
        capturedListenCallback?.(
          makeTaskPayload({
            taskId: "task-2",
            chunk: "Live stdout line\n",
            type: "stdout",
            id: 10,
          }),
        );
      }, 10);
    };

    const res = await GET(request, { params: Promise.resolve({ id: "task-2" }) });
    const frames = await collectFrames(res.body!, 2, injectLive);

    expect(listenCallbackReady).toBe(true);

    expect(frames[0].type).toBe("connected");
    expect((frames[0] as Record<string, unknown>).taskId).toBe("task-2");

    expect(frames[1].type).toBe("stdout");
    expect((frames[1] as Record<string, unknown>).chunk).toBe("Live stdout line\n");
    expect((frames[1] as Record<string, unknown>).taskId).toBe("task-2");
    expect((frames[1] as Record<string, unknown>).id).toBe(10);
  });

  // ── 3. Reconnect without duplicates (Last-Event-ID dedup) ─────────────────
  it("does not re-send rows already seen when Last-Event-ID is provided", async () => {
    // Rows 1-3 already received by client; server should only send row 4+
    mockReplayRows = [
      makeDbRow({ id: 4, chunk: "New line after reconnect\n", type: "stdout" }),
      makeDbRow({ id: 5, chunk: "", type: "done" }),
    ];

    const request = new Request("http://localhost/api/tasks/task-3/stream", {
      headers: { "last-event-id": "3" },
      signal: AbortSignal.timeout(2000),
    });

    const res = await GET(request, { params: Promise.resolve({ id: "task-3" }) });
    const frames = await collectAllFrames(res.body!);

    // "connected" + only the two new rows (rows 1-3 not re-sent)
    expect(frames).toHaveLength(3);
    expect(frames[0].type).toBe("connected");
    expect((frames[1] as Record<string, unknown>).id).toBe(4);
    expect((frames[1] as Record<string, unknown>).chunk).toBe("New line after reconnect\n");
    expect((frames[2] as Record<string, unknown>).id).toBe(5);
    expect((frames[2] as Record<string, unknown>).type).toBe("done");
  });

  // ── 4. Auto-close on "done" event ────────────────────────────────────────
  it("closes the stream after the terminal done event arrives via pg_notify", async () => {
    // No historical rows — agent will emit "done" live
    mockReplayRows = [];

    const request = new Request("http://localhost/api/tasks/task-4/stream", {
      signal: AbortSignal.timeout(3000),
    });

    const injectDone = () => {
      setTimeout(() => {
        capturedListenCallback?.(
          makeTaskPayload({
            taskId: "task-4",
            chunk: "work output\n",
            type: "stdout",
            id: 7,
          }),
        );
        setTimeout(() => {
          capturedListenCallback?.(
            makeTaskPayload({
              taskId: "task-4",
              chunk: "",
              type: "done",
              id: 8,
            }),
          );
        }, 5);
      }, 10);
    };

    const res = await GET(request, { params: Promise.resolve({ id: "task-4" }) });
    // collectFrames triggers injectDone after "connected"
    const frames = await collectFrames(res.body!, 1, injectDone);

    // Now drain the rest — stream should close naturally after "done"
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const remaining: Array<Record<string, unknown>> = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
        if (dataLine) remaining.push(JSON.parse(dataLine.slice(6)));
      }
    }

    const all = [...frames, ...remaining];
    expect(all[0].type).toBe("connected");

    const doneFrame = all.find((f) => f.type === "done");
    expect(doneFrame).toBeDefined();
    expect((doneFrame as Record<string, unknown>).id).toBe(8);

    // After "done" the reader.done should be true — verified by the for loop ending
  });

  // ── 5. Dedup of live chunks arriving during the replay window ─────────────
  it("deduplicates live chunks that arrive during the replay window", async () => {
    mockReplayRows = [
      makeDbRow({ id: 5, chunk: "overlap chunk", type: "stdout" }),
      makeDbRow({ id: 6, chunk: "", type: "done" }),
    ];

    const request = new Request("http://localhost/api/tasks/task-5/stream", {
      headers: { "last-event-id": "4" },
      signal: AbortSignal.timeout(2000),
    });

    const duplicatePayload = makeTaskPayload({
      taskId: "task-5",
      chunk: "overlap chunk",
      type: "stdout",
      id: 5,
    });

    const res = await GET(request, { params: Promise.resolve({ id: "task-5" }) });

    // Fire duplicate into pendingLive (arrives before liveReady flips)
    capturedListenCallback?.(duplicatePayload);

    const frames = await collectAllFrames(res.body!);

    // id=5 must appear exactly once (not duplicated by both replay and pendingLive drain)
    const id5Frames = frames.filter((f) => (f as Record<string, unknown>).id === 5);
    expect(id5Frames).toHaveLength(1);

    // Total: "connected" + id=5 + id=6 (done)
    expect(frames).toHaveLength(3);
  });
});
