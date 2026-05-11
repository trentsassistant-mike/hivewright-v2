import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";

const TEST_SECRET = "test-secret-do-not-ship";

// Heavyweight imports stubbed so the unit test runs without GPU sockets,
// real DB, or the EA runtime stack.
const mocks = vi.hoisted(() => ({
  insertReturning: vi.fn(),
  openSttClient: vi.fn(),
  openTtsClient: vi.fn(),
  runtimeStart: vi.fn(),
  runtimeFeedMicAudio: vi.fn(),
  runtimeStop: vi.fn(),
}));

vi.mock("@/db", () => {
  const chain = {
    values: vi.fn(() => chain),
    returning: vi.fn(() => mocks.insertReturning()),
    set: vi.fn(() => chain),
    where: vi.fn().mockResolvedValue(undefined),
  };
  return { db: { insert: vi.fn(() => chain), update: vi.fn(() => chain) } };
});

vi.mock("@/db/schema/voice-sessions", () => ({
  voiceSessions: {},
  voiceSessionEvents: {},
}));
vi.mock("@/db/schema/connectors", () => ({ connectorInstalls: {} }));

vi.mock("@/connectors/voice/runtime", () => ({
  VoiceSessionRuntime: class {
    start(...args: unknown[]) { return mocks.runtimeStart(...args); }
    feedMicAudio(...args: unknown[]) { return mocks.runtimeFeedMicAudio(...args); }
    stop(...args: unknown[]) { return mocks.runtimeStop(...args); }
  },
}));

vi.mock("@/connectors/voice/gpu-clients", () => ({
  openSttClient: mocks.openSttClient,
  openTtsClient: mocks.openTtsClient,
}));

vi.mock("@/ea/native/voice-adapter", () => ({ eaVoiceClient: {} }));

import { mountDirectWsHandler } from "@/connectors/voice/direct-ws";
import { signVoiceSessionToken } from "@/lib/voice-session-token";

class FakeWs {
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  sent: Array<{ data: unknown; binary?: boolean }> = [];
  listeners: Record<string, Array<(...a: unknown[]) => void>> = {};

  send(data: unknown, opts?: { binary?: boolean }): void {
    this.sent.push({ data, binary: opts?.binary });
  }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
  }
  on(event: string, fn: (...a: unknown[]) => void): this {
    (this.listeners[event] ??= []).push(fn);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners[event] ?? []) fn(...args);
  }
}

function fakeRequest(token?: string, host = "voice.example.ts.net"): IncomingMessage {
  const path = token ? `/api/voice/direct/ws?token=${encodeURIComponent(token)}` : "/api/voice/direct/ws";
  return {
    url: path,
    headers: { host },
  } as unknown as IncomingMessage;
}

const fakeSql = (() => {
  // Tagged-template fn that returns a Promise<rows[]>. Only used for the
  // voiceServicesUrl lookup in this test; we always return one row.
  const fn = () => Promise.resolve([{ config: { voiceServicesUrl: "http://gpu.local:8790" } }]);
  return fn as unknown as Parameters<typeof mountDirectWsHandler>[0];
})();

describe("mountDirectWsHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_SERVICE_TOKEN = TEST_SECRET;
    process.env.VOICE_SERVICES_URL = "http://gpu.local:8790";
    mocks.insertReturning.mockResolvedValue([{ id: "session-1", hiveId: "hive-1" }]);
    mocks.openSttClient.mockResolvedValue({ on: vi.fn(), send: vi.fn(), close: vi.fn() });
    mocks.openTtsClient.mockResolvedValue({ on: vi.fn(), send: vi.fn(), close: vi.fn() });
  });

  afterEach(() => {
    delete process.env.INTERNAL_SERVICE_TOKEN;
    delete process.env.VOICE_SERVICES_URL;
  });

  it("rejects an upgrade with no token", async () => {
    const ws = new FakeWs();
    await mountDirectWsHandler(fakeSql, ws as unknown as WebSocket, fakeRequest());
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1008);
  });

  it("rejects an upgrade with a malformed token", async () => {
    const ws = new FakeWs();
    await mountDirectWsHandler(fakeSql, ws as unknown as WebSocket, fakeRequest("not-a-real-token"));
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1008);
  });

  it("rejects an upgrade with a token signed by a different secret", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "wrong-secret";
    const token = signVoiceSessionToken({ hiveId: "hive-1", ownerId: "owner-1" });
    process.env.INTERNAL_SERVICE_TOKEN = TEST_SECRET;
    const ws = new FakeWs();
    await mountDirectWsHandler(fakeSql, ws as unknown as WebSocket, fakeRequest(token));
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(1008);
  });

  it("accepts a valid token, opens a runtime, sends session id frame, and starts listening", async () => {
    const token = signVoiceSessionToken({ hiveId: "hive-1", ownerId: "owner-1" });
    const ws = new FakeWs();
    await mountDirectWsHandler(fakeSql, ws as unknown as WebSocket, fakeRequest(token));

    // The handler should NOT have closed the socket.
    expect(ws.closed).toBe(false);
    // First sent frame is the session-id JSON.
    expect(ws.sent[0]?.data).toBe(JSON.stringify({ type: "session", id: "session-1" }));
    // Runtime should have been started.
    expect(mocks.runtimeStart).toHaveBeenCalledWith({
      source: "direct-ws",
      ownerId: "owner-1",
    });
  });

  it("forwards inbound binary frames to runtime.feedMicAudio", async () => {
    const token = signVoiceSessionToken({ hiveId: "hive-1", ownerId: "owner-1" });
    const ws = new FakeWs();
    await mountDirectWsHandler(fakeSql, ws as unknown as WebSocket, fakeRequest(token));

    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    ws.emit("message", pcm, true);

    expect(mocks.runtimeFeedMicAudio).toHaveBeenCalledWith(pcm);
  });

  it("calls runtime.stop on a JSON {type:'hangup'} control frame", async () => {
    const token = signVoiceSessionToken({ hiveId: "hive-1", ownerId: "owner-1" });
    const ws = new FakeWs();
    await mountDirectWsHandler(fakeSql, ws as unknown as WebSocket, fakeRequest(token));

    ws.emit("message", JSON.stringify({ type: "hangup" }), false);

    expect(mocks.runtimeStop).toHaveBeenCalledWith("user_hangup");
  });

  it("calls runtime.stop on socket close", async () => {
    const token = signVoiceSessionToken({ hiveId: "hive-1", ownerId: "owner-1" });
    const ws = new FakeWs();
    await mountDirectWsHandler(fakeSql, ws as unknown as WebSocket, fakeRequest(token));

    ws.emit("close");

    expect(mocks.runtimeStop).toHaveBeenCalledWith("user_hangup");
  });
});
