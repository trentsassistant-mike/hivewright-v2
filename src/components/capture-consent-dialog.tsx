"use client";

import { useState } from "react";

interface CaptureConsentDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function CaptureConsentDialog({
  open,
  onConfirm,
  onCancel,
}: CaptureConsentDialogProps) {
  const [checked, setChecked] = useState(false);

  if (!open) return null;

  function handleConfirm() {
    setChecked(false);
    onConfirm();
  }

  function handleCancel() {
    setChecked(false);
    onCancel();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      <div className="relative mx-4 w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl">
        <h2
          id="consent-dialog-title"
          className="text-lg font-semibold text-amber-50"
        >
          Start browser capture?
        </h2>
        <p className="mt-1 text-sm text-amber-400/70">
          Review what this session records and how it is used before you begin.
        </p>

        <ul className="mt-4 space-y-2.5 rounded-lg border border-amber-200/10 bg-amber-950/20 p-4 text-sm text-amber-100/80">
          <li className="flex items-start gap-2.5">
            <span className="mt-px shrink-0 text-amber-400" aria-hidden="true">
              ▸
            </span>
            <span>
              Records your <strong>current browser tab only</strong> — no audio,
              no desktop, no other tabs or applications.
            </span>
          </li>
          <li className="flex items-start gap-2.5">
            <span className="mt-px shrink-0 text-amber-400" aria-hidden="true">
              ▸
            </span>
            <span>
              Your browser will display a screen-sharing indicator throughout.
              You can stop at any time using the controls that appear.
            </span>
          </li>
          <li className="flex items-start gap-2.5">
            <span className="mt-px shrink-0 text-amber-400" aria-hidden="true">
              ▸
            </span>
            <span>
              Captured content stays{" "}
              <strong>local in this browser tab</strong>. No video, audio, or
              raw media is uploaded to the server in this MVP.
            </span>
          </li>
          <li className="flex items-start gap-2.5">
            <span className="mt-px shrink-0 text-amber-400" aria-hidden="true">
              ▸
            </span>
            <span>
              <strong>No automation activates</strong> automatically. Any
              generated workflow requires your explicit review and approval
              before it does anything.
            </span>
          </li>
        </ul>

        <label className="mt-5 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-amber-500"
          />
          <span className="text-sm text-amber-100/90">
            I understand what will be captured and consent to this recording
            session.
          </span>
        </label>

        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            onClick={handleCancel}
            className="rounded px-3 py-1.5 text-sm text-amber-400/70 hover:text-amber-200"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!checked}
            className="rounded bg-amber-600 px-4 py-1.5 text-sm font-medium text-amber-950 hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Start Recording
          </button>
        </div>
      </div>
    </div>
  );
}
