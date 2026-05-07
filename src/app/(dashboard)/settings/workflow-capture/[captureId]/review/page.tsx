"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useHiveContext } from "@/components/hive-context";

interface CaptureSession {
  id: string;
  status: string;
  startedAt: string | null;
  stoppedAt: string | null;
  captureScope: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  evidenceSummary: Record<string, unknown> | null;
  redactedSummary?: string | null;
}

interface CaptureDraft {
  id: string;
  slug: string;
  status: string;
  qaReviewStatus: string | null;
  securityReviewStatus: string | null;
  internalSourceRef: string | null;
  provenanceUrl: string | null;
  publishedAt: string | null;
}

interface CaptureDraftPreview {
  title: string;
  observedSteps: string[];
  inferredInputs: string[];
  decisionNotes: string[];
  confidence: {
    level: "low" | "medium" | "high";
    score: number;
    rationale: string;
  };
  sensitiveDataWarnings: string[];
  redactionNotes: string[];
  suggestedSkillContent: string;
  source: {
    captureSessionId: string;
    fieldsUsed: string[];
    rawMediaAccepted: false;
  };
}

interface DraftPreviewResult {
  preview: CaptureDraftPreview;
  previewStatus: "generated" | "rejected" | "approved";
  approvedDraftId: string | null;
  approvedDraftStatus: string | null;
  rawMediaAccepted: false;
}

interface DraftCreateResult {
  draft: CaptureDraft;
  created: boolean;
  duplicate: boolean;
  message: string;
  rawMediaAccepted: false;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString();
}

function durationLabel(startedAt: string | null, stoppedAt: string | null): string {
  if (!startedAt || !stoppedAt) return "-";
  const secs = Math.max(
    0,
    Math.round((new Date(stoppedAt).getTime() - new Date(startedAt).getTime()) / 1000),
  );
  const m = Math.floor(secs / 60).toString().padStart(2, "0");
  const s = (secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-zinc-900/60 p-3 text-xs text-amber-100/70">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export default function CaptureReviewPage() {
  const params = useParams<{ captureId: string }>();
  const { selected } = useHiveContext();
  const router = useRouter();
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [draftResult, setDraftResult] = useState<DraftCreateResult | null>(null);
  const [draftPreview, setDraftPreview] = useState<DraftPreviewResult | null>(null);
  const [editedSkillContent, setEditedSkillContent] = useState("");
  const [draftPreviewLoading, setDraftPreviewLoading] = useState(false);
  const [draftCreating, setDraftCreating] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftRejecting, setDraftRejecting] = useState(false);

  useEffect(() => {
    const id = params.captureId;
    if (!id) return;
    setLoading(true);
    setError(null);
    fetch(`/api/capture-sessions/${id}`)
      .then(async (res) => {
        const body = await res.json() as { data?: CaptureSession; error?: string };
        if (!res.ok) throw new Error(body.error ?? "Failed to load session");
        if (!body.data) throw new Error("No session data returned");
        setSession(body.data);
        setDraftPreviewLoading(true);
        const draftRes = await fetch(`/api/capture-sessions/${id}/draft`);
        const draftBody = await draftRes.json() as { data?: DraftPreviewResult; error?: string };
        if (!draftRes.ok) throw new Error(draftBody.error ?? "Failed to load draft preview");
        if (draftBody.data) {
          setDraftPreview(draftBody.data);
          setEditedSkillContent(draftBody.data.preview.suggestedSkillContent);
        }
      })
      .catch((e: unknown) => setError((e as Error).message))
      .finally(() => {
        setLoading(false);
        setDraftPreviewLoading(false);
      });
  }, [params.captureId]);

  async function handleDelete() {
    if (!session) return;
    if (!window.confirm("Delete this capture session and all metadata? This cannot be undone.")) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`/api/capture-sessions/${session.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? "Delete failed");
      }
      router.push("/setup/workflow-capture");
    } catch (e) {
      setError((e as Error).message);
      setDeleting(false);
    }
  }

  async function handleApproveDraft() {
    if (!session || draftResult || draftCreating) return;
    setDraftCreating(true);
    setDraftError(null);
    try {
      const res = await fetch(`/api/capture-sessions/${session.id}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reviewNotes: "Approved from capture review shell.",
          suggestedSkillContent: editedSkillContent,
        }),
      });
      const body = await res.json() as { data?: DraftCreateResult; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Draft creation failed");
      if (!body.data) throw new Error("No draft data returned");
      setDraftResult(body.data);
    } catch (e) {
      setDraftError((e as Error).message);
    } finally {
      setDraftCreating(false);
    }
  }

  async function handleRejectDraft() {
    if (!session || draftRejecting) return;
    setDraftRejecting(true);
    setDraftError(null);
    try {
      const res = await fetch(`/api/capture-sessions/${session.id}/draft`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Rejected in capture review shell." }),
      });
      const body = await res.json() as { data?: { previewStatus: "rejected" }; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Draft rejection failed");
      setDraftPreview((current) => current
        ? { ...current, previewStatus: "rejected" }
        : current);
    } catch (e) {
      setDraftError((e as Error).message);
    } finally {
      setDraftRejecting(false);
    }
  }

  if (!selected) {
    return <p className="text-amber-400/60">Select a hive to view this capture session.</p>;
  }

  const draftButtonLabel = draftCreating
    ? "Approving..."
    : draftResult
      ? "Inactive draft created"
      : "Approve Draft";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/setup/workflow-capture" className="text-sm text-amber-400/60 hover:text-amber-200">
            Back
          </Link>
          <h1 className="text-2xl font-semibold text-amber-50">Session review</h1>
        </div>
        {session && (
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="rounded border border-rose-500/30 px-3 py-1.5 text-sm text-rose-400 hover:border-rose-400/60 hover:text-rose-200 disabled:opacity-50"
          >
            {deleting ? "Deleting..." : "Delete session"}
          </button>
        )}
      </div>

      {loading && (
        <div className="rounded-lg border border-border bg-card p-5">
          <p className="animate-pulse text-sm text-amber-400/60">Loading session...</p>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/20 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {session && (
        <>
          <div className="space-y-3 rounded-lg border border-border bg-card p-5">
            <h2 className="text-sm font-medium text-amber-100">Session details</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-amber-400/60">Status</dt>
              <dd><span className="rounded bg-amber-950/40 px-1.5 py-0.5 font-mono text-xs text-amber-200">{session.status}</span></dd>
              <dt className="text-amber-400/60">Session ID</dt>
              <dd className="break-all font-mono text-xs text-amber-100/70">{session.id}</dd>
              <dt className="text-amber-400/60">Started</dt>
              <dd className="text-amber-50">{formatDateTime(session.startedAt)}</dd>
              <dt className="text-amber-400/60">Stopped</dt>
              <dd className="text-amber-50">{formatDateTime(session.stoppedAt)}</dd>
              <dt className="text-amber-400/60">Duration</dt>
              <dd className="font-mono text-amber-50">{durationLabel(session.startedAt, session.stoppedAt)}</dd>
              {session.captureScope && (
                <>
                  <dt className="text-amber-400/60">Capture scope</dt>
                  <dd className="font-mono text-xs text-amber-100/70">{JSON.stringify(session.captureScope)}</dd>
                </>
              )}
            </dl>
          </div>

          <div className="space-y-4 rounded-lg border border-border bg-card p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-2">
                <h2 className="text-sm font-medium text-amber-100">Draft preview</h2>
                <p className="max-w-2xl text-sm text-amber-400/70">
                  Review a pending workflow draft generated from capture scope, evidence summary,
                  redacted summary, and safe session metadata only. The draft stays
                  inactive; no workflow is published, approved, installed, or activated.
                </p>
                <p className="text-xs text-amber-500/60">
                  AI step inference is still pending future work when inferred steps are not already present in the metadata.
                </p>
                <p className="text-xs text-amber-500/60">
                  No raw video, audio, screenshots, frames, or media blobs are uploaded to the server.
                </p>
              </div>
              <button
                onClick={handleApproveDraft}
                disabled={draftCreating || Boolean(draftResult) || draftPreview?.previewStatus === "rejected"}
                className="shrink-0 rounded border border-amber-500/40 px-3 py-1.5 text-sm text-amber-100 hover:border-amber-300/70 hover:text-amber-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {draftButtonLabel}
              </button>
            </div>

            <div className="rounded border border-amber-500/15 bg-amber-950/10 px-3 py-2 text-xs text-amber-300/70">
              Draft status before approval: pending future analysis/inactive. Raw media accepted: false.
            </div>

            {draftPreviewLoading && (
              <p className="animate-pulse text-sm text-amber-400/60">Generating metadata-only draft preview...</p>
            )}

            {draftPreview && (
              <div className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-2 rounded border border-amber-500/15 bg-zinc-950/40 p-3">
                    <h3 className="text-xs font-semibold uppercase text-amber-300/70">Observed steps</h3>
                    <ul className="list-disc space-y-1 pl-4 text-sm text-amber-100/75">
                      {draftPreview.preview.observedSteps.map((step) => <li key={step}>{step}</li>)}
                    </ul>
                  </div>
                  <div className="space-y-2 rounded border border-amber-500/15 bg-zinc-950/40 p-3">
                    <h3 className="text-xs font-semibold uppercase text-amber-300/70">Inputs and placeholders</h3>
                    <ul className="list-disc space-y-1 pl-4 text-sm text-amber-100/75">
                      {draftPreview.preview.inferredInputs.map((input) => <li key={input}>{input}</li>)}
                    </ul>
                  </div>
                  <div className="space-y-2 rounded border border-amber-500/15 bg-zinc-950/40 p-3">
                    <h3 className="text-xs font-semibold uppercase text-amber-300/70">Decision notes</h3>
                    <ul className="list-disc space-y-1 pl-4 text-sm text-amber-100/75">
                      {draftPreview.preview.decisionNotes.map((note) => <li key={note}>{note}</li>)}
                    </ul>
                  </div>
                  <div className="space-y-2 rounded border border-amber-500/15 bg-zinc-950/40 p-3">
                    <h3 className="text-xs font-semibold uppercase text-amber-300/70">Confidence and warnings</h3>
                    <p className="text-sm text-amber-100/75">
                      {draftPreview.preview.confidence.level} ({draftPreview.preview.confidence.score.toFixed(2)}): {draftPreview.preview.confidence.rationale}
                    </p>
                    <ul className="list-disc space-y-1 pl-4 text-sm text-amber-100/75">
                      {[...draftPreview.preview.sensitiveDataWarnings, ...draftPreview.preview.redactionNotes].map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                </div>

                <label className="block space-y-2">
                  <span className="text-xs font-semibold uppercase text-amber-300/70">SKILL.md draft body</span>
                  <textarea
                    value={editedSkillContent}
                    onChange={(event) => setEditedSkillContent(event.target.value)}
                    rows={14}
                    className="w-full rounded border border-amber-500/20 bg-zinc-950/70 p-3 font-mono text-xs text-amber-50 outline-none focus:border-amber-300/60"
                  />
                </label>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={handleRejectDraft}
                    disabled={draftRejecting || draftPreview.previewStatus === "rejected" || Boolean(draftResult)}
                    className="rounded border border-rose-500/30 px-3 py-1.5 text-sm text-rose-300 hover:border-rose-400/60 hover:text-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {draftRejecting ? "Rejecting..." : draftPreview.previewStatus === "rejected" ? "Draft rejected" : "Reject Draft"}
                  </button>
                  <p className="text-xs text-amber-500/60">
                    Preview status: {draftPreview.previewStatus}. Fields used: {draftPreview.preview.source.fieldsUsed.join(", ")}.
                  </p>
                </div>
              </div>
            )}

            {draftError && (
              <div role="alert" className="rounded border border-rose-500/30 bg-rose-950/20 px-3 py-2 text-sm text-rose-300">
                {draftError}
              </div>
            )}

            {draftResult && (
              <div className="space-y-2 rounded border border-amber-500/20 bg-amber-950/10 px-3 py-2 text-sm text-amber-100/80">
                <p>{draftResult.duplicate ? "Existing inactive pending draft found." : draftResult.message}</p>
                <p className="break-all font-mono text-xs text-amber-100/70">
                  Draft ID: {draftResult.draft.id} - Status: {draftResult.draft.status} - QA: {draftResult.draft.qaReviewStatus ?? "pending"}
                </p>
                <p className="text-xs text-amber-500/60">Source: {draftResult.draft.internalSourceRef}</p>
              </div>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {session.metadata && (
              <div className="space-y-2 rounded-lg border border-border bg-card p-5">
                <h2 className="text-sm font-medium text-amber-100">Safe metadata</h2>
                <JsonBlock value={session.metadata} />
              </div>
            )}
            {session.evidenceSummary && (
              <div className="space-y-2 rounded-lg border border-border bg-card p-5">
                <h2 className="text-sm font-medium text-amber-100">Evidence summary</h2>
                <JsonBlock value={session.evidenceSummary} />
              </div>
            )}
          </div>

          {session.redactedSummary && (
            <div className="space-y-2 rounded-lg border border-border bg-card p-5">
              <h2 className="text-sm font-medium text-amber-100">Redacted summary</h2>
              <p className="whitespace-pre-wrap text-sm text-amber-100/70">{session.redactedSummary}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
