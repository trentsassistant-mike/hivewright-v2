"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useHiveContext } from "@/components/hive-context";
import { CaptureConsentDialog } from "@/components/capture-consent-dialog";
import { CaptureRecordingPill } from "@/components/capture-recording-pill";

type CapturePhase =
  | "idle"
  | "consent"
  | "creating"
  | "requesting_media"
  | "recording"
  | "stopping"
  | "cancelling";

function isSupportedBrowser(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
    typeof window.MediaRecorder !== "undefined"
  );
}

export default function WorkflowCapturePage() {
  const { selected } = useHiveContext();
  const router = useRouter();

  const [phase, setPhase] = useState<CapturePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [durationSecs, setDurationSecs] = useState(0);
  const [browserSupported, setBrowserSupported] = useState(true);

  // Refs hold mutable session/media state so event handlers always see current values
  const phaseRef = useRef<CapturePhase>("idle");
  const sessionIdRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // router ref so stream event handlers don't capture a stale router
  const routerRef = useRef(router);
  useEffect(() => { routerRef.current = router; }, [router]);

  function syncPhase(p: CapturePhase) {
    phaseRef.current = p;
    setPhase(p);
  }

  useEffect(() => {
    setBrowserSupported(isSupportedBrowser());
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cleanupMedia = useCallback(() => {
    stopTimer();
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      try {
        recorderRef.current.stop();
      } catch {
        // ignore — track may already be ended
      }
    }
    recorderRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    chunksRef.current = [];
    setDurationSecs(0);
  }, [stopTimer]);

  // Purge local media on unmount
  useEffect(() => {
    return () => cleanupMedia();
  }, [cleanupMedia]);

  function startTimer() {
    timerRef.current = setInterval(() => {
      setDurationSecs((prev) => prev + 1);
    }, 1000);
  }

  // Stop recording: patch session to stopped → navigate to review.
  // Uses refs so it's safe to call from stream event handlers.
  const triggerStop = useCallback(async () => {
    if (
      phaseRef.current === "stopping" ||
      phaseRef.current === "cancelling" ||
      phaseRef.current === "idle"
    ) {
      return;
    }
    const sessionId = sessionIdRef.current;
    syncPhase("stopping");
    cleanupMedia();

    if (!sessionId) {
      syncPhase("idle");
      return;
    }

    try {
      const res = await fetch(`/api/capture-sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "stopped" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Failed to update session");
      }
    } catch (e) {
      setError(`Session stopped locally but failed to update on the server: ${(e as Error).message}`);
      syncPhase("idle");
      return;
    }

    routerRef.current.push(
      `/setup/workflow-capture/${sessionId}/review`,
    );
  }, [cleanupMedia]);

  // Keep a stable ref so stream/recorder event handlers always call the latest version
  const triggerStopRef = useRef(triggerStop);
  useEffect(() => { triggerStopRef.current = triggerStop; }, [triggerStop]);

  function handleOpenConsent() {
    if (!browserSupported) {
      setError(
        "Screen capture is not supported in this browser. Try Chrome, Edge, or Firefox.",
      );
      return;
    }
    setError(null);
    syncPhase("consent");
  }

  function handleConsentCancel() {
    syncPhase("idle");
  }

  async function handleConsentConfirm() {
    if (!selected) return;

    // Step 1: Create the session (consent=true, status=recording)
    syncPhase("creating");
    let createdSessionId: string;
    try {
      const res = await fetch("/api/capture-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hiveId: selected.id,
          consent: true,
          status: "recording",
          captureScope: { type: "browser_tab" },
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(
          (body as { error?: string }).error ?? "Failed to create capture session",
        );
      }
      createdSessionId = (body as { data: { id: string } }).data.id;
      sessionIdRef.current = createdSessionId;
    } catch (e) {
      setError((e as Error).message);
      syncPhase("idle");
      return;
    }

    // Step 2: Request display capture permission — getDisplayMedia only called here,
    // after the user has explicitly confirmed consent.
    syncPhase("requesting_media");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "browser" } as MediaTrackConstraints,
        audio: false,
      });
      streamRef.current = stream;
    } catch (e) {
      const name = (e as DOMException).name;
      const msg =
        name === "NotAllowedError" || name === "PermissionDeniedError"
          ? "Screen capture permission was denied. The session has been cancelled."
          : name === "NotSupportedError"
            ? "Screen capture is not supported in this browser."
            : `Could not start capture: ${(e as Error).message}`;
      setError(msg);
      // Cancel the session we already created
      try {
        await fetch(`/api/capture-sessions/${createdSessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "cancelled" }),
        });
      } catch {
        // non-fatal — best-effort cleanup
      }
      sessionIdRef.current = null;
      syncPhase("idle");
      return;
    }

    // Step 3: Initialise MediaRecorder — blobs stay local, never uploaded
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        // Accumulate chunks locally; they are discarded on cancel / page unload
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        setError("The recording encountered an error and has been stopped.");
        void triggerStopRef.current();
      };

      recorder.start(1_000); // 1-second chunks, kept in memory only
    } catch (e) {
      setError(`MediaRecorder failed to start: ${(e as Error).message}`);
      cleanupMedia();
      try {
        await fetch(`/api/capture-sessions/${createdSessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "cancelled" }),
        });
      } catch {
        // non-fatal
      }
      sessionIdRef.current = null;
      syncPhase("idle");
      return;
    }

    // Step 4: Auto-stop when the captured source ends (user closes the shared tab/window)
    stream.getTracks().forEach((track) => {
      track.onended = () => {
        void triggerStopRef.current();
      };
    });

    syncPhase("recording");
    startTimer();
  }

  async function handleStop() {
    await triggerStop();
  }

  async function handleCancel() {
    if (
      phaseRef.current === "stopping" ||
      phaseRef.current === "cancelling" ||
      phaseRef.current === "idle"
    ) {
      return;
    }
    if (!window.confirm("Discard this recording? Nothing will be saved.")) {
      return;
    }

    const sessionId = sessionIdRef.current;
    syncPhase("cancelling");
    cleanupMedia();
    sessionIdRef.current = null;

    if (sessionId) {
      try {
        // Hard-purge: try DELETE first; if session state doesn't allow it, fall back to PATCH+cancelled
        const deleteRes = await fetch(`/api/capture-sessions/${sessionId}`, {
          method: "DELETE",
        });
        if (!deleteRes.ok) {
          // Fallback: mark cancelled
          const patchRes = await fetch(`/api/capture-sessions/${sessionId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "cancelled" }),
          });
          if (!patchRes.ok) {
            const body = await patchRes.json().catch(() => ({}));
            throw new Error(
              (body as { error?: string }).error ?? "Failed to cancel session on the server",
            );
          }
        }
      } catch (e) {
        // Non-fatal: recording is already discarded locally
        setError(
          `Recording cancelled locally. Server cleanup may have partially failed: ${(e as Error).message}`,
        );
        syncPhase("idle");
        return;
      }
    }

    syncPhase("idle");
  }

  if (!selected) {
    return (
      <p className="text-amber-400/60">
        Select a hive to use browser capture.
      </p>
    );
  }

  const isActiveCapture =
    phase === "recording" || phase === "stopping" || phase === "cancelling";

  return (
    <>
      {/* Recording pill: fixed overlay, visible above all page chrome */}
      {isActiveCapture && (
        <CaptureRecordingPill
          durationSecs={durationSecs}
          onStop={handleStop}
          onCancel={handleCancel}
          stopping={phase === "stopping"}
          cancelling={phase === "cancelling"}
        />
      )}

      {/* Consent gate: getDisplayMedia is NOT called until this confirms */}
      <CaptureConsentDialog
        open={phase === "consent"}
        onConfirm={handleConsentConfirm}
        onCancel={handleConsentCancel}
      />

      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-amber-50">
            Browser capture
          </h1>
          <p className="text-sm text-amber-600/70">
            Record your browser tab as you work. HiveWright reviews the session
            and drafts a workflow for your approval — no automation activates
            without your sign-off.
          </p>
        </div>

        {/* Error banner */}
        {error && (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded-lg border border-rose-500/30 bg-rose-950/20 px-4 py-3 text-sm text-rose-300"
          >
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="shrink-0 text-xs text-rose-400/60 underline hover:text-rose-200"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Browser support warning */}
        {!browserSupported && (
          <div
            role="alert"
            className="rounded-lg border border-amber-500/30 bg-amber-950/20 px-4 py-3 text-sm text-amber-300"
          >
            Screen capture is not supported in this browser. Use Chrome, Edge,
            or Firefox to enable browser capture.
          </div>
        )}

        {/* Main card */}
        <div className="rounded-lg border border-border bg-card p-5 space-y-4">
          {phase === "idle" && (
            <>
              <div className="space-y-2">
                <h2 className="text-sm font-medium text-amber-100">
                  How it works
                </h2>
                <ol className="list-decimal list-inside space-y-1.5 text-sm text-amber-400/75">
                  <li>Confirm consent — browser tab only, no audio.</li>
                  <li>
                    Your browser prompts you to select the tab to share.
                  </li>
                  <li>Work through your task normally.</li>
                  <li>
                    Click <strong>Stop</strong> when done and review the
                    session.
                  </li>
                  <li>
                    Approve, edit, or discard — nothing activates
                    automatically.
                  </li>
                </ol>
              </div>

              <button
                onClick={handleOpenConsent}
                disabled={!browserSupported}
                className="rounded bg-amber-600 px-4 py-2 text-sm font-medium text-amber-950 hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Start browser capture
              </button>
            </>
          )}

          {phase === "creating" && (
            <p className="animate-pulse text-sm text-amber-400/70">
              Creating capture session…
            </p>
          )}

          {phase === "requesting_media" && (
            <p className="animate-pulse text-sm text-amber-400/70">
              Waiting for screen selection — select a browser tab in the
              dialog that appeared.
            </p>
          )}

          {isActiveCapture && (
            <div className="space-y-2">
              <p className="text-sm text-amber-400/70">
                Recording is in progress. Use the{" "}
                <strong>Stop</strong> or <strong>Cancel</strong> controls in
                the top-right corner.
              </p>
              {phase === "stopping" && (
                <p className="animate-pulse text-sm text-amber-400/60">
                  Stopping session…
                </p>
              )}
              {phase === "cancelling" && (
                <p className="animate-pulse text-sm text-amber-400/60">
                  Cancelling and discarding…
                </p>
              )}
            </div>
          )}
        </div>

        {/* Link to manual SOP importer */}
        {phase === "idle" && (
          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-sm font-medium text-amber-100">
              Prefer to describe in writing?
            </h2>
            <p className="mt-1 text-sm text-amber-400/70">
              Use the{" "}
              <Link
                href="/setup/sop-importer"
                className="text-amber-400 underline hover:text-amber-200"
              >
                manual SOP importer
              </Link>{" "}
              to paste or write a workflow directly.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
