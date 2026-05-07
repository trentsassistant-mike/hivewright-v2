import { eq } from "drizzle-orm";
import { WebSocket as WsClient, type RawData } from "ws";
import { db } from "@/db";
import {
  voiceSessions,
  voiceSessionEvents,
} from "@/db/schema/voice-sessions";
import { VoiceprintVerifier } from "./voiceprint-verifier";
import type { VoiceTransport } from "./voice-transport";

/**
 * Voice session state machine.
 *
 * - `connecting`: runtime constructed; waiting for session_start.
 * - `listening`: call is up; forwarding caller PCM16 audio to STT.
 * - `processing`: STT produced a final transcript; EA is being queried.
 * - `speaking`: EA has started streaming tokens; audio is flowing back.
 * - `silence_wait`: EA finished, waiting for the next caller phrase.
 * - `ended`: call torn down.
 *
 * The six-state enum matches the voice EA v1 plan exactly. `silence_wait` is
 * reserved for VAD/barge-in work and is not entered in this initial runtime.
 */
type State =
  | "connecting"
  | "listening"
  | "processing"
  | "speaking"
  | "silence_wait"
  | "ended";

export interface VoiceRuntimeDeps {
  hiveId: string;
  sessionId: string;
  sttClient: WsClient;
  ttsClient: WsClient;
  eaClient: {
    submit(
      text: string,
      ctx: { sessionId: string; hiveId: string },
    ):
      | Promise<AsyncIterable<string>>
      | AsyncIterable<string>;
  };
  /**
   * Carrier-agnostic outbound channel. The runtime only knows "PCM16 mono
   * 24 kHz frames go out"; the transport handles carrier-specific encoding
   * (μ-law/base64 for Twilio, raw bytes for direct-WS).
   */
  transport: VoiceTransport;
  /**
   * GPU voice-services base URL (e.g. `http://gpu.local:8790`). Needed by
   * the in-call voiceprint verifier to POST 3-second windows at
   * `<url>/voiceprint/embed`.
   */
  voiceServicesUrl: string;
}

/**
 * Runtime for a single in-progress voice call. Owns the STT/TTS/EA
 * clients for the session, accepts PCM mic audio frames from whatever
 * carrier is in front of it, and writes session events to Postgres.
 */
export class VoiceSessionRuntime {
  state: State = "connecting";
  private inFlightTranscript: Promise<void> = Promise.resolve();
  private voiceprintVerifier: VoiceprintVerifier;

  constructor(private deps: VoiceRuntimeDeps) {
    this.voiceprintVerifier = new VoiceprintVerifier({
      hiveId: deps.hiveId,
      voiceServicesUrl: deps.voiceServicesUrl,
      onFail: () => this.onVoiceprintFail(),
    });
    this.wireSttTranscripts();
    this.wireTtsAudio();
  }

  private onVoiceprintFail(): void {
    if (this.state === "ended") return;
    console.warn(
      `[voice] voiceprint verification failed — ending session ${this.deps.sessionId}`,
    );
    this.state = "ended";
    try {
      this.deps.ttsClient.send(
        JSON.stringify({
          type: "text",
          text: "I'm not recognizing this voice. Hanging up — if this is you, re-enroll your voiceprint in settings and try again.",
        }),
      );
      this.deps.ttsClient.send(JSON.stringify({ type: "eof" }));
    } catch {
      // ignore: TTS may already be closed
    }
    setTimeout(() => {
      try { this.deps.sttClient.close(); } catch { /* ignore */ }
      try { this.deps.ttsClient.close(); } catch { /* ignore */ }
      try { this.deps.transport.close(); } catch { /* ignore */ }
    }, 1500);
    db.update(voiceSessions)
      .set({ endedAt: new Date(), endReason: "voiceprint_fail" })
      .where(eq(voiceSessions.id, this.deps.sessionId))
      .catch((e) =>
        console.error("[voice] session update (voiceprint_fail) failed:", e),
      );
  }

  /**
   * Mark the session live. Carriers call this when their handshake
   * completes (Twilio: on `start` frame; direct-WS: on connection open).
   * Persists `session_start` with whatever metadata the carrier surfaced.
   */
  start(metadata: Record<string, unknown> = {}): void {
    if (this.state !== "connecting") return;
    this.state = "listening";
    db.insert(voiceSessionEvents)
      .values({
        sessionId: this.deps.sessionId,
        kind: "session_start",
        metadata,
      })
      .catch((e) => console.error("[voice] session_start insert failed", e));
  }

  /**
   * Feed a PCM16 mono 16 kHz buffer of caller audio to the STT pipeline.
   * Carriers convert from their wire format to PCM16/16k before calling
   * this (Twilio: μ-law/8k → PCM/8k → upsample/16k; direct-WS: pass-through).
   */
  feedMicAudio(pcm16k: Buffer): void {
    if (this.state !== "listening") return;
    this.deps.sttClient.send(pcm16k);
    this.voiceprintVerifier.pushSamples(pcm16k);
  }

  /**
   * Tear the session down. Carriers call this on hangup / socket close.
   */
  stop(reason: string = "user_hangup"): void {
    if (this.state === "ended") return;
    this.state = "ended";
    void Promise.race([
      this.inFlightTranscript,
      new Promise((r) => setTimeout(r, 2000)),
    ])
      .catch(() => undefined)
      .finally(() => {
        try { this.deps.sttClient.close(); } catch { /* ignore */ }
        try { this.deps.ttsClient.close(); } catch { /* ignore */ }
        void import("./post-call-summary")
          .then(({ postCallSummary }) =>
            postCallSummary(this.deps.hiveId, this.deps.sessionId),
          )
          .catch((err) =>
            console.error(
              "[voice] post-call summary dispatch failed:",
              err,
            ),
          );
      });
    db.update(voiceSessions)
      .set({ endedAt: new Date(), endReason: reason })
      .where(eq(voiceSessions.id, this.deps.sessionId))
      .catch((e) => console.error("[voice] session update failed", e));
  }

  private wireSttTranscripts(): void {
    this.deps.sttClient.on("message", (raw: RawData) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "final") return;
      // Re-entrancy guard: only accept a new final transcript when we're
      // actively listening. Drop duplicates so we don't spawn concurrent
      // EA turns.
      if (this.state !== "listening") return;
      this.inFlightTranscript = this.handleFinalTranscript(msg.text).catch(
        (e) => console.error("[voice] transcript handler failed", e),
      );
    });
  }

  private async handleFinalTranscript(text: string): Promise<void> {
    this.state = "processing";
    await db.insert(voiceSessionEvents).values({
      sessionId: this.deps.sessionId,
      kind: "user_phrase",
      text,
    });
    const stream = await this.deps.eaClient.submit(text, {
      sessionId: this.deps.sessionId,
      hiveId: this.deps.hiveId,
    });
    this.state = "speaking";
    // Stream the EA reply to TTS sentence-by-sentence so audio starts
    // playing while the LLM is still generating the rest of the reply.
    // Pre-Phase-A this loop accumulated the whole reply before sending to
    // TTS — adding 2-4 s of dead air between "I stop talking" and "EA
    // starts speaking." Now the TTS WS receives one `{type:"text"}` frame
    // per complete sentence; Kokoro handles them sequentially.
    let acc = "";
    let pending = "";
    for await (const chunk of stream) {
      acc += chunk;
      pending += chunk;
      pending = this.flushSentencesToTts(pending);
    }
    // Flush any trailing fragment that didn't end on a sentence boundary
    // (e.g. a one-word reply or an answer without final punctuation).
    const tail = pending.trim();
    if (tail) {
      this.deps.ttsClient.send(JSON.stringify({ type: "text", text: tail }));
    }
    await db.insert(voiceSessionEvents).values({
      sessionId: this.deps.sessionId,
      kind: "ea_phrase",
      text: acc,
    });
    this.state = "listening";
  }

  /**
   * Pull every complete sentence out of `pending` and send each one to
   * TTS as a separate `{type:"text"}` frame. Returns whatever's left
   * after the last sentence boundary so the caller can keep accumulating
   * into it.
   *
   * Boundary heuristic: `.`, `!`, `?` followed by whitespace or end of
   * string. Keeps the punctuation in the emitted sentence so Kokoro
   * gets the prosodic cue. Doesn't try to handle abbreviations
   * (e.g. "Mr.") — false positives are mild (one-word synth) and the
   * only cost is slightly choppier prosody, never silence.
   */
  private flushSentencesToTts(pending: string): string {
    const re = /[.!?]+(?:\s+|$)/g;
    let lastCut = 0;
    let m;
    while ((m = re.exec(pending)) !== null) {
      const cut = m.index + m[0].length;
      const sentence = pending.slice(lastCut, cut).trim();
      if (sentence) {
        this.deps.ttsClient.send(
          JSON.stringify({ type: "text", text: sentence }),
        );
      }
      lastCut = cut;
    }
    return pending.slice(lastCut);
  }

  private wireTtsAudio(): void {
    this.deps.ttsClient.on("message", (raw: RawData) => {
      const buf = Buffer.isBuffer(raw)
        ? raw
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : Array.isArray(raw)
            ? Buffer.concat(raw)
            : null;
      if (!buf) return;
      // Hand the raw PCM16 mono 24 kHz buffer to the carrier transport.
      // The transport decides whether to downsample/encode (Twilio path
      // does μ-law @ 8 kHz) or pass through (direct-WS path).
      this.deps.transport.sendTtsAudio(buf);
    });
  }
}

