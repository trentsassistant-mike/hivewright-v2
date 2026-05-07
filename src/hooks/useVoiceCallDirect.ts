"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export type CallStatus = "idle" | "connecting" | "active" | "ending" | "error";

interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

interface VoiceDirectSessionInfo {
  wsUrl: string;
  sessionToken: string;
  expiresIn: number;
}

/**
 * Direct PCM-over-WebSocket voice client. Replaces the Twilio Voice JS
 * SDK in v2 of the Voice EA (post-2026-05-07).
 *
 * Surface mirrors `useVoiceCall` deliberately so the UI components (call
 * button, transcript panel, audio-level meter) don't need to learn the
 * new transport.
 */
// Minimal Wake Lock typings — TypeScript's lib.dom doesn't yet ship them
// in some toolchains and we don't want to require a typings upgrade for
// one optional API call.
interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}
interface WakeLockApiLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

export function useVoiceCallDirect(hiveId: string) {
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playbackCtxRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  // Wake Lock keeps the screen on for the duration of an active call.
  // Without it, Android's screen lock (and some iOS power-save paths)
  // suspends the page and silently kills the WebSocket — looks to the
  // owner like a random disconnect mid-conversation.
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const visibilityListenerRef = useRef<(() => void) | null>(null);
  // Playback state — we schedule TTS chunks back-to-back so the next chunk
  // starts exactly when the previous one ends, avoiding clicks/gaps.
  const nextStartTimeRef = useRef<number>(0);

  const [status, setStatus] = useState<CallStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);

  // Track event IDs we've already appended to the transcript. EventSource
  // auto-reconnects on transient errors and our SSE handler restarts its
  // cursor at 0 on each fresh connection — without this guard, every
  // reconnect would replay the whole transcript from the start, which is
  // exactly the spam pattern observed during 2026-05-07 smoke testing.
  const seenEventIdsRef = useRef<Set<string>>(new Set());

  const subscribeTranscript = useCallback((sessionId: string) => {
    eventSourceRef.current?.close();
    seenEventIdsRef.current = new Set();
    const es = new EventSource(`/api/voice/sessions/${sessionId}/events`);
    eventSourceRef.current = es;
    const push = (role: "user" | "assistant") => (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data);
        const id =
          typeof data?.id === "string"
            ? data.id
            : typeof data?.eventId === "string"
              ? data.eventId
              : null;
        if (id && seenEventIdsRef.current.has(id)) return;
        if (id) seenEventIdsRef.current.add(id);
        if (data?.text) {
          setTranscript((prev) => [...prev, { role, text: data.text }]);
        }
      } catch {
        // Malformed frame — ignore, SSE is best-effort.
      }
    };
    es.addEventListener("user_phrase", push("user") as EventListener);
    es.addEventListener("ea_phrase", push("assistant") as EventListener);
    es.addEventListener("error", () => {
      // EventSource auto-reconnects; swallow to avoid console spam.
      // The seen-id set above keeps replays from accumulating.
    });
  }, []);

  const acquireWakeLock = useCallback(async () => {
    // Best-effort: not all browsers support this (most modern ones do).
    // Failures are logged once and never propagated — losing wake lock
    // means the screen may sleep, not that the call breaks.
    const nav = navigator as Navigator & { wakeLock?: WakeLockApiLike };
    if (!nav.wakeLock?.request) return;
    try {
      const sentinel = await nav.wakeLock.request("screen");
      wakeLockRef.current = sentinel;
      sentinel.addEventListener("release", () => {
        // Browser auto-released (typically on tab background). We'll
        // re-request when the page is visible again — see the
        // visibilitychange listener in startCall.
        wakeLockRef.current = null;
      });
    } catch (err) {
      console.warn("[voice] wake lock request failed:", err);
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    const sentinel = wakeLockRef.current;
    wakeLockRef.current = null;
    if (sentinel && !sentinel.released) {
      sentinel.release().catch(() => {});
    }
  }, []);

  const playPcm24kFrame = useCallback((pcm: ArrayBuffer) => {
    const ctx = playbackCtxRef.current;
    if (!ctx) return;
    const samples = pcm.byteLength / 2;
    if (samples === 0) return;
    const view = new DataView(pcm);
    const audioBuffer = ctx.createBuffer(1, samples, 24000);
    const out = audioBuffer.getChannelData(0);
    for (let i = 0; i < samples; i++) {
      out[i] = view.getInt16(i * 2, true) / 32768;
    }
    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, nextStartTimeRef.current);
    src.start(startAt);
    nextStartTimeRef.current = startAt + audioBuffer.duration;
  }, []);

  const cleanup = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    seenEventIdsRef.current = new Set();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    playbackCtxRef.current?.close().catch(() => {});
    playbackCtxRef.current = null;
    wsRef.current = null;
    releaseWakeLock();
    if (visibilityListenerRef.current) {
      document.removeEventListener("visibilitychange", visibilityListenerRef.current);
      visibilityListenerRef.current = null;
    }
  }, [releaseWakeLock]);

  const startCall = useCallback(async () => {
    if (status === "connecting" || status === "active") return;
    setStatus("connecting");
    setError(null);
    setTranscript([]);

    try {
      // 1. Mint a signed handshake token.
      const tokenRes = await fetch("/api/voice/direct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId }),
      });
      if (!tokenRes.ok) {
        throw new Error(`voice session mint failed: ${tokenRes.status}`);
      }
      const session = (await tokenRes.json()) as VoiceDirectSessionInfo;

      // 2. Open the WS to the dispatcher.
      // Compute the WS URL on the client because the server can be behind a
      // reverse proxy (Tailscale serve) that obscures the public hostname.
      // `window.location` is always the real public URL the user is on.
      const wsScheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${wsScheme}//${window.location.host}/api/voice/direct/ws?token=${encodeURIComponent(session.sessionToken)}`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      // Register WS event handlers up-front, BEFORE any await. The audio
      // setup below `await`s on getUserMedia (which can take seconds while
      // the user grants mic permission); if the WS opens during that wait
      // and we register `open` after, our listener never fires and the UI
      // stays stuck at "connecting" even though audio works.
      ws.addEventListener("open", () => {
        setStatus("active");
        // Hold the screen on for the duration of the call. Ignored on
        // browsers without the API; the visibilitychange listener below
        // re-acquires after backgrounding.
        void acquireWakeLock();
      });
      ws.addEventListener("message", (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          playPcm24kFrame(ev.data);
          return;
        }
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data);
            if (msg?.type === "session" && typeof msg.id === "string") {
              subscribeTranscript(msg.id);
            }
          } catch {
            // Malformed control frame — ignore.
          }
        }
      });
      ws.addEventListener("close", () => {
        cleanup();
        setStatus("idle");
      });
      ws.addEventListener("error", () => {
        setError("voice connection error");
        setStatus("error");
        cleanup();
      });

      // 3. Set up audio I/O.
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      micStreamRef.current = mic;

      // Capture and playback contexts. We use separate contexts because
      // the playback rate is fixed at 24 kHz (Kokoro's output) and the
      // capture context follows the device's native rate (typically 48 kHz)
      // so the worklet can do a single resample step. Browsers tolerate
      // multiple AudioContexts cleanly.
      const captureCtx = new AudioContext();
      audioCtxRef.current = captureCtx;
      try {
        await captureCtx.audioWorklet.addModule("/voice/audio-capture-worklet.js");
      } catch (err) {
        throw new Error(
          `audio worklet load failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const source = captureCtx.createMediaStreamSource(mic);
      const worklet = new AudioWorkletNode(captureCtx, "pcm-capture");
      source.connect(worklet);
      // The worklet must be in the graph for process() to fire, but its
      // output is silence — pipe to a dummy gain so it counts as connected
      // without becoming audible feedback.
      const sink = captureCtx.createGain();
      sink.gain.value = 0;
      worklet.connect(sink).connect(captureCtx.destination);
      worklet.port.onmessage = (ev: MessageEvent) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(ev.data);
        }
      };

      const playbackCtx = new AudioContext({ sampleRate: 24000 });
      playbackCtxRef.current = playbackCtx;
      nextStartTimeRef.current = 0;

      // If the WS already opened during the audio setup `await`s above,
      // the `open` listener registered up-front already fired and set
      // status="active" — but only if it raced ahead of the listener
      // attach, which it can't because we attached before the awaits.
      // This `readyState` check is a belt-and-braces fallback for
      // environments where the open event fires synchronously during
      // construction (which spec-compliant browsers don't, but we don't
      // depend on that).
      if (ws.readyState === WebSocket.OPEN) {
        // React bails out on duplicate state writes, so it's safe to call
        // even if the `open` listener already set this.
        setStatus("active");
      }

      // Wake-lock re-acquire on visibility return. The browser auto-releases
      // wake locks when a page backgrounds; we re-request when the page is
      // visible AND we're still on a call. Listener is removed in cleanup.
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible" && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          void acquireWakeLock();
        }
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      visibilityListenerRef.current = onVisibilityChange;
    } catch (e) {
      const message =
        e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string"
          ? (e as { message: string }).message
          : typeof e === "string"
            ? e
            : "Unknown voice error";
      setError(message);
      setStatus("error");
      cleanup();
    }
  }, [acquireWakeLock, cleanup, hiveId, playPcm24kFrame, subscribeTranscript, status]);

  const endCall = useCallback(() => {
    setStatus("ending");
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: "hangup" })); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
    }
    cleanup();
    setStatus("idle");
  }, [cleanup]);

  const pushTranscript = useCallback(
    (entry: TranscriptEntry) =>
      setTranscript((prev) => [...prev, entry]),
    [],
  );

  // React Strict Mode (dev) simulates an unmount/remount; keep cleanup
  // resource-only and avoid calling setStatus from here so the page
  // doesn't get wedged at "ending".
  useEffect(() => {
    return () => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.close(); } catch { /* ignore */ }
      }
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { status, error, transcript, startCall, endCall, pushTranscript };
}
