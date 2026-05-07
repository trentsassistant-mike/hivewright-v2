import { beforeEach, describe, it, expect, vi, type Mock } from "vitest";
import type { VoiceRuntimeDeps } from "@/connectors/voice/runtime";

const postCallSummaryMock = vi.hoisted(() => vi.fn());

// Stub @/db so the state-machine tests don't hit Postgres. The
// re-entrancy test needs the `user_phrase` insert to resolve quickly so
// the EA `submit()` is actually reached on the first final transcript; a
// real DB call with a fake sessionId would FK-fail and never reach submit.
vi.mock("@/db", () => {
  const chain = {
    values: vi.fn().mockResolvedValue(undefined),
    set: vi.fn(() => chain),
    where: vi.fn().mockResolvedValue(undefined),
  };
  return {
    db: {
      insert: vi.fn(() => chain),
      update: vi.fn(() => chain),
    },
  };
});

vi.mock("@/connectors/voice/post-call-summary", () => ({
  postCallSummary: postCallSummaryMock,
}));

import { VoiceSessionRuntime } from "@/connectors/voice/runtime";

type MockWs = { send: Mock; close: Mock; on: Mock };

function asSttClient(ws: MockWs): VoiceRuntimeDeps["sttClient"] {
  return ws as unknown as VoiceRuntimeDeps["sttClient"];
}

function mockWs(): MockWs {
  return { send: vi.fn(), close: vi.fn(), on: vi.fn() };
}

function mockEa(): VoiceRuntimeDeps["eaClient"] {
  return { submit: vi.fn(async function* () {}) };
}

function mockTransport(): VoiceRuntimeDeps["transport"] {
  return { sendTtsAudio: vi.fn(), close: vi.fn() };
}

describe("VoiceSessionRuntime state machine", () => {
  beforeEach(() => {
    postCallSummaryMock.mockReset();
    postCallSummaryMock.mockResolvedValue(undefined);
  });

  it("transitions connecting -> listening on start()", () => {
    const rt = new VoiceSessionRuntime({
      hiveId: "hive-1",
      sessionId: "s-1",
      sttClient: asSttClient(mockWs()),
      ttsClient: asSttClient(mockWs()),
      eaClient: mockEa(),
      transport: mockTransport(),
      voiceServicesUrl: "http://mock.local:8790",
    });
    expect(rt.state).toBe("connecting");
    rt.start({ source: "direct-ws" });
    expect(rt.state).toBe("listening");
  });

  it("forwards mic audio to STT only while listening", () => {
    const stt = mockWs();
    const rt = new VoiceSessionRuntime({
      hiveId: "hive-1",
      sessionId: "s-1",
      sttClient: asSttClient(stt),
      ttsClient: asSttClient(mockWs()),
      eaClient: mockEa(),
      transport: mockTransport(),
      voiceServicesUrl: "http://mock.local:8790",
    });
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    // Pre-start: drop.
    rt.feedMicAudio(pcm);
    expect(stt.send).not.toHaveBeenCalled();
    rt.start({});
    rt.feedMicAudio(pcm);
    expect(stt.send).toHaveBeenCalledWith(pcm);
  });

  it("ends on stop()", () => {
    const rt = new VoiceSessionRuntime({
      hiveId: "hive-1",
      sessionId: "s-1",
      sttClient: asSttClient(mockWs()),
      ttsClient: asSttClient(mockWs()),
      eaClient: mockEa(),
      transport: mockTransport(),
      voiceServicesUrl: "http://mock.local:8790",
    });
    rt.start({});
    rt.stop("user_hangup");
    expect(rt.state).toBe("ended");
  });

  it("ignores duplicate stop() calls so one summary dispatch lands", async () => {
    let summaryLanded = false;
    const landedSummaries: string[] = [];
    postCallSummaryMock.mockImplementation(async (_hiveId, sessionId) => {
      if (summaryLanded) return;
      summaryLanded = true;
      landedSummaries.push(sessionId);
    });

    const rt = new VoiceSessionRuntime({
      hiveId: "hive-1",
      sessionId: "s-1",
      sttClient: asSttClient(mockWs()),
      ttsClient: asSttClient(mockWs()),
      eaClient: mockEa(),
      transport: mockTransport(),
      voiceServicesUrl: "http://mock.local:8790",
    });
    rt.start({});
    rt.stop("user_hangup");
    rt.stop("user_hangup");

    const deadline = Date.now() + 2000;
    while (postCallSummaryMock.mock.calls.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(postCallSummaryMock).toHaveBeenCalledTimes(1);
    expect(landedSummaries).toEqual(["s-1"]);
  });

  it("ignores a second final transcript while one is in flight", async () => {
    // `submit` returns an async iterable that never yields, so the first
    // transcript handler stays parked in `processing`/`speaking` forever.
    const submit = vi.fn(
      async () =>
        (async function* () {
          await new Promise(() => {});
        })(),
    );
    const eaClient: VoiceRuntimeDeps["eaClient"] = { submit };

    const sttClient = {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    };
    const rt = new VoiceSessionRuntime({
      hiveId: "hive-1",
      sessionId: "s-1",
      sttClient: asSttClient(sttClient),
      ttsClient: asSttClient({ send: vi.fn(), close: vi.fn(), on: vi.fn() }),
      eaClient,
      transport: { sendTtsAudio: vi.fn(), close: vi.fn() },
      voiceServicesUrl: "http://mock.local:8790",
    });
    rt.start({});
    expect(rt.state).toBe("listening");

    // Grab the listener the runtime registered on the STT client.
    const onCall = sttClient.on.mock.calls.find(
      (c: unknown[]) => c[0] === "message",
    );
    expect(onCall).toBeDefined();
    if (!onCall) throw new Error("expected STT message listener");
    const listener = onCall[1];
    // First final kicks the handler into processing. The listener is
    // synchronous (fire-and-forget), so we poll until state advances past
    // `listening` (which happens once the async handler's initial DB insert
    // resolves). 2s cap so a hung DB doesn't wedge the test run forever.
    listener(Buffer.from(JSON.stringify({ type: "final", text: "hi" })));
    const deadline = Date.now() + 2000;
    while (rt.state === "listening" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(rt.state).not.toBe("listening");

    // Second final while still processing/speaking must be ignored.
    listener(Buffer.from(JSON.stringify({ type: "final", text: "again" })));
    await new Promise((r) => setTimeout(r, 50));

    // submit should have been called exactly once — not twice.
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("streams the EA reply to TTS sentence-by-sentence", async () => {
    // EA produces two sentences across three chunks. We expect the runtime
    // to emit two `{type:"text"}` frames to the TTS client — one per
    // complete sentence — instead of waiting for the whole reply.
    const submit = vi.fn(
      async () =>
        (async function* () {
          yield "Hello there. ";
          yield "How are ";
          yield "you?";
        })(),
    );
    const ttsClient = mockWs();
    const sttClient = mockWs();
    const rt = new VoiceSessionRuntime({
      hiveId: "hive-1",
      sessionId: "s-1",
      sttClient: asSttClient(sttClient),
      ttsClient: asSttClient(ttsClient),
      eaClient: { submit },
      transport: mockTransport(),
      voiceServicesUrl: "http://mock.local:8790",
    });
    rt.start({});
    // Find the STT message listener and drive the transcript through it.
    const onCall = sttClient.on.mock.calls.find(
      (c: unknown[]) => c[0] === "message",
    );
    if (!onCall) throw new Error("expected STT message listener");
    onCall[1](Buffer.from(JSON.stringify({ type: "final", text: "hi" })));

    // Poll until state advances back to "listening" (handleFinalTranscript
    // has finished). 2 s cap to avoid wedging on a hung mock DB.
    const deadline = Date.now() + 2000;
    while (rt.state !== "listening" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(rt.state).toBe("listening");

    // The TTS client should have received two frames, one per sentence.
    const sent = ttsClient.send.mock.calls.map((c) => c[0] as string);
    expect(sent).toEqual([
      JSON.stringify({ type: "text", text: "Hello there." }),
      JSON.stringify({ type: "text", text: "How are you?" }),
    ]);
  });

  it("flushes a trailing fragment without a sentence boundary", async () => {
    const submit = vi.fn(
      async () =>
        (async function* () {
          yield "Sure";
        })(),
    );
    const ttsClient = mockWs();
    const sttClient = mockWs();
    const rt = new VoiceSessionRuntime({
      hiveId: "hive-1",
      sessionId: "s-1",
      sttClient: asSttClient(sttClient),
      ttsClient: asSttClient(ttsClient),
      eaClient: { submit },
      transport: mockTransport(),
      voiceServicesUrl: "http://mock.local:8790",
    });
    rt.start({});
    const onCall = sttClient.on.mock.calls.find(
      (c: unknown[]) => c[0] === "message",
    );
    if (!onCall) throw new Error("expected STT message listener");
    onCall[1](Buffer.from(JSON.stringify({ type: "final", text: "hi" })));

    const deadline = Date.now() + 2000;
    while (rt.state !== "listening" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(ttsClient.send.mock.calls.map((c) => c[0])).toEqual([
      JSON.stringify({ type: "text", text: "Sure" }),
    ]);
  });

  it("hands TTS audio frames to the transport", () => {
    const transport = mockTransport();
    const tts = mockWs();
    new VoiceSessionRuntime({
      hiveId: "hive-1",
      sessionId: "s-1",
      sttClient: asSttClient(mockWs()),
      ttsClient: asSttClient(tts),
      eaClient: mockEa(),
      transport,
      voiceServicesUrl: "http://mock.local:8790",
    });
    // Grab the message listener the runtime registered on the TTS client.
    const onCall = tts.on.mock.calls.find((c) => c[0] === "message");
    expect(onCall).toBeDefined();
    if (!onCall) throw new Error("expected TTS message listener");
    const listener = onCall[1];
    const pcm24k = Buffer.from([1, 2, 3, 4]);
    listener(pcm24k);
    expect(transport.sendTtsAudio).toHaveBeenCalledWith(pcm24k);
  });
});
