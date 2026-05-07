"use client";
import type { CallStatus } from "@/hooks/useVoiceCallDirect";

export function CallButton({
  status,
  onStart,
  onEnd,
}: {
  status: CallStatus;
  onStart: () => void;
  onEnd: () => void;
}) {
  if (status === "idle" || status === "error") {
    return (
      <button
        type="button"
        onClick={onStart}
        className="rounded-full bg-green-600 px-8 py-4 text-white text-lg shadow hover:bg-green-700"
      >
        📞 Call EA
      </button>
    );
  }
  if (status === "connecting") {
    return (
      <button
        type="button"
        disabled
        aria-disabled="true"
        className="rounded-full bg-red-600/60 px-8 py-4 text-white text-lg shadow cursor-not-allowed"
      >
        Connecting…
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onEnd}
      className="rounded-full bg-red-600 px-8 py-4 text-white text-lg shadow hover:bg-red-700"
    >
      End call
    </button>
  );
}
