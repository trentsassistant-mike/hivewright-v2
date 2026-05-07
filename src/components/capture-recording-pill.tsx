"use client";

function formatDuration(totalSecs: number): string {
  const m = Math.floor(totalSecs / 60)
    .toString()
    .padStart(2, "0");
  const s = (totalSecs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

interface CaptureRecordingPillProps {
  durationSecs: number;
  onStop: () => void;
  onCancel: () => void;
  stopping?: boolean;
  cancelling?: boolean;
}

export function CaptureRecordingPill({
  durationSecs,
  onStop,
  onCancel,
  stopping = false,
  cancelling = false,
}: CaptureRecordingPillProps) {
  const busy = stopping || cancelling;
  const label = formatDuration(durationSecs);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Recording in progress. Duration: ${label}`}
      className="fixed right-4 top-4 z-50 flex items-center gap-3 rounded-full border border-red-500/25 bg-zinc-900/92 px-4 py-2 shadow-2xl backdrop-blur-md"
    >
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500"
      />
      <span className="min-w-[3.6ch] font-mono text-sm tabular-nums text-white">
        {label}
      </span>
      <button
        onClick={onStop}
        disabled={busy}
        aria-label="Stop recording"
        className="rounded bg-white/12 px-3 py-1 text-xs font-medium text-white hover:bg-white/22 disabled:opacity-50"
      >
        {stopping ? "Stopping…" : "Stop"}
      </button>
      <button
        onClick={onCancel}
        disabled={busy}
        aria-label="Cancel recording and discard all captured content"
        className="rounded px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
      >
        {cancelling ? "Cancelling…" : "Cancel"}
      </button>
    </div>
  );
}
