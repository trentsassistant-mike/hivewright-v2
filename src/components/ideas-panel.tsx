"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { validateAttachmentFiles } from "@/attachments/constants";
import {
  AttachmentDropzone,
  type AttachmentFileEntry,
  createAttachmentFileEntries,
  revokeAttachmentFileEntries,
} from "@/components/attachment-dropzone";
import { AttachmentsPanel } from "@/components/attachments-panel";

type Idea = {
  id: string;
  title: string;
  body: string | null;
  createdBy: string;
  createdAt: string;
  status: "open" | "reviewed" | "promoted" | "archived";
  aiAssessment: string | null;
  promotedToGoalId: string | null;
};

type EditableIdeaStatus = Extract<Idea["status"], "open" | "reviewed">;

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function buildPromotionBrief(idea: Idea) {
  const sourceParagraph = `Source idea id: ${idea.id}`;
  const detailLines = [
    `Promote this idea into a goal.`,
    `Title: ${idea.title}`,
  ];

  if (idea.body?.trim()) {
    detailLines.push("", idea.body.trim());
  }

  detailLines.push(
    "",
    "Build and implement this as a meaningful goal for the hive. Design the scope clearly and create the work as a goal rather than a task.",
  );

  return `${sourceParagraph}\n\n${detailLines.join("\n")}`;
}

export function IdeasPanel({ hiveId }: { hiveId: string }) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showComposer, setShowComposer] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<AttachmentFileEntry[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [editingIdeaId, setEditingIdeaId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editFiles, setEditFiles] = useState<AttachmentFileEntry[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [editFileError, setEditFileError] = useState<string | null>(null);
  const [savingIdeaId, setSavingIdeaId] = useState<string | null>(null);
  const [savedIdeaId, setSavedIdeaId] = useState<string | null>(null);
  const filesRef = useRef<AttachmentFileEntry[]>([]);
  const editFilesRef = useRef<AttachmentFileEntry[]>([]);

  const loadIdeas = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [openRes, reviewedRes] = await Promise.all([
        fetch(`/api/hives/${hiveId}/ideas?status=open`),
        fetch(`/api/hives/${hiveId}/ideas?status=reviewed`),
      ]);
      if (!openRes.ok || !reviewedRes.ok) throw new Error("Failed to load ideas");
      const [openPayload, reviewedPayload] = await Promise.all([
        openRes.json(),
        reviewedRes.json(),
      ]);
      const nextIdeas = [...(openPayload.data ?? []), ...(reviewedPayload.data ?? [])] as Idea[];
      nextIdeas.sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
      );
      setIdeas(nextIdeas);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load ideas");
    } finally {
      setLoading(false);
    }
  }, [hiveId]);

  useEffect(() => {
    loadIdeas();
  }, [loadIdeas]);

  useEffect(() => {
    if (!savedIdeaId) return;
    const timeoutId = window.setTimeout(() => setSavedIdeaId(null), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [savedIdeaId]);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    editFilesRef.current = editFiles;
  }, [editFiles]);

  useEffect(() => {
    return () => {
      revokeAttachmentFileEntries(filesRef.current);
      revokeAttachmentFileEntries(editFilesRef.current);
    };
  }, []);

  function isEditable(idea: Idea): idea is Idea & { status: EditableIdeaStatus } {
    return idea.status === "open" || idea.status === "reviewed";
  }

  function addComposerFiles(incoming: File[]) {
    setFileError(null);
    const validationError = validateAttachmentFiles([
      ...files.map((entry) => entry.file),
      ...incoming,
    ]);
    if (validationError) {
      setFileError(validationError);
      return;
    }

    setFiles((current) => [...current, ...createAttachmentFileEntries(incoming)]);
  }

  function removeComposerFile(index: number) {
    setFiles((current) => {
      const entry = current[index];
      if (entry?.objectUrl) URL.revokeObjectURL(entry.objectUrl);
      return current.filter((_, currentIndex) => currentIndex !== index);
    });
    setFileError(null);
  }

  function addEditFiles(incoming: File[]) {
    setEditFileError(null);
    const validationError = validateAttachmentFiles([
      ...editFiles.map((entry) => entry.file),
      ...incoming,
    ]);
    if (validationError) {
      setEditFileError(validationError);
      return;
    }

    setEditFiles((current) => [...current, ...createAttachmentFileEntries(incoming)]);
  }

  function removeEditFile(index: number) {
    setEditFiles((current) => {
      const entry = current[index];
      if (entry?.objectUrl) URL.revokeObjectURL(entry.objectUrl);
      return current.filter((_, currentIndex) => currentIndex !== index);
    });
    setEditFileError(null);
  }

  function beginEditing(idea: Idea & { status: EditableIdeaStatus }) {
    setEditingIdeaId(idea.id);
    setEditTitle(idea.title);
    setEditBody(idea.body ?? "");
    setEditError(null);
    setEditFileError(null);
    setSavedIdeaId(null);
    revokeAttachmentFileEntries(editFiles);
    setEditFiles([]);
  }

  function cancelEditing() {
    setEditingIdeaId(null);
    setEditTitle("");
    setEditBody("");
    setEditError(null);
    setEditFileError(null);
    revokeAttachmentFileEntries(editFiles);
    setEditFiles([]);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    setSubmitting(true);
    setError(null);
    try {
      const hasFiles = files.length > 0;
      const res = await fetch(`/api/hives/${hiveId}/ideas`, hasFiles
        ? {
            method: "POST",
            body: (() => {
              const formData = new FormData();
              formData.append("title", trimmedTitle);
              if (body.trim()) formData.append("body", body.trim());
              files.forEach((entry) => formData.append("files", entry.file));
              return formData;
            })(),
          }
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: trimmedTitle,
              body: body.trim() || undefined,
            }),
          });
      if (!res.ok) throw new Error("Failed to save idea");
      const payload = await res.json();
      const createdIdea = payload.data as Idea;
      setIdeas((current) => [createdIdea, ...current]);
      setTitle("");
      setBody("");
      revokeAttachmentFileEntries(files);
      setFiles([]);
      setFileError(null);
      setShowComposer(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save idea");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleArchive(ideaId: string) {
    setPendingActionId(ideaId);
    setError(null);
    try {
      const res = await fetch(`/api/hives/${hiveId}/ideas/${ideaId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
      if (!res.ok) throw new Error("Failed to archive idea");
      setIdeas((current) => current.filter((idea) => idea.id !== ideaId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to archive idea");
    } finally {
      setPendingActionId(null);
    }
  }

  async function handlePromote(idea: Idea) {
    setPendingActionId(idea.id);
    setError(null);
    try {
      const promoteRes = await fetch("/api/work", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hiveId,
          input: buildPromotionBrief(idea),
        }),
      });
      if (!promoteRes.ok) throw new Error("Failed to promote idea");

      const promotePayload = await promoteRes.json();
      if (promotePayload.data?.type !== "goal" || typeof promotePayload.data?.id !== "string") {
        throw new Error("Promotion must create a goal via /api/work");
      }

      const goalId = promotePayload.data.id as string;
      const patchRes = await fetch(`/api/hives/${hiveId}/ideas/${idea.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "promoted",
          promoted_to_goal_id: goalId,
        }),
      });
      if (!patchRes.ok) throw new Error("Failed to update promoted idea");

      const patchPayload = await patchRes.json();
      const updatedIdea = patchPayload.data as Idea;
      setIdeas((current) =>
        current.map((entry) => (entry.id === idea.id ? updatedIdea : entry)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to promote idea");
    } finally {
      setPendingActionId(null);
    }
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>, ideaId: string) {
    event.preventDefault();
    const trimmedTitle = editTitle.trim();
    if (!trimmedTitle) {
      setEditError("Title is required");
      return;
    }

    setSavingIdeaId(ideaId);
    setEditError(null);
    setError(null);
    try {
      const hasFiles = editFiles.length > 0;
      const res = await fetch(`/api/hives/${hiveId}/ideas/${ideaId}`, hasFiles
        ? {
            method: "PATCH",
            body: (() => {
              const formData = new FormData();
              formData.append("title", trimmedTitle);
              formData.append("body", editBody.trim());
              editFiles.forEach((entry) => formData.append("files", entry.file));
              return formData;
            })(),
          }
        : {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: trimmedTitle,
              body: editBody.trim() || null,
            }),
          });
      if (!res.ok) throw new Error("Failed to save idea");

      const payload = await res.json();
      const updatedIdea = payload.data as Idea;
      setIdeas((current) =>
        current.map((idea) => (idea.id === ideaId ? updatedIdea : idea)),
      );
      setSavedIdeaId(ideaId);
      cancelEditing();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Failed to save idea");
    } finally {
      setSavingIdeaId(null);
    }
  }

  return (
    <section className="space-y-4 rounded-lg border p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium text-amber-900 dark:text-amber-100">Ideas</h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Park half-formed ideas here. Open and reviewed items are shown newest first.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowComposer((value) => !value)}
          className="cursor-pointer rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800"
        >
          {showComposer ? "Cancel" : "+ Add idea"}
        </button>
      </div>

      {showComposer && (
        <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border border-amber-200/70 bg-amber-50/50 p-4 dark:border-amber-400/20 dark:bg-amber-400/5">
          <div className="space-y-1">
            <label htmlFor="idea-title" className="text-sm font-medium text-amber-900 dark:text-amber-100">
              Title
            </label>
            <input
              id="idea-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              placeholder="What should we come back to?"
              maxLength={255}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="idea-body" className="text-sm font-medium text-amber-900 dark:text-amber-100">
              Notes
            </label>
            <textarea
              id="idea-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={4}
              className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
              placeholder="Optional detail, context, or rough next step."
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-amber-900 dark:text-amber-100">
              Attachments
            </label>
            <AttachmentDropzone
              files={files}
              error={fileError}
              disabled={submitting}
              onAddFiles={addComposerFiles}
              onRemoveFile={removeComposerFile}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Captured as owner.</p>
            <button
              type="submit"
              disabled={submitting || title.trim().length === 0}
              className="cursor-pointer rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {submitting ? "Saving..." : "Save idea"}
            </button>
          </div>
        </form>
      )}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      {loading ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading ideas...</p>
      ) : ideas.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No active ideas yet.</p>
      ) : (
        <div className="space-y-3">
          {ideas.map((idea) => (
            <article key={idea.id} className="space-y-3 rounded-lg border p-4">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h3 className="text-base font-medium text-amber-900 dark:text-amber-100">{idea.title}</h3>
                  <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 dark:text-zinc-400">
                    {idea.createdBy}
                  </span>
                  {idea.status !== "open" && (
                    <span className="text-xs uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">
                      {idea.status}
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {formatTimestamp(idea.createdAt)}
                </p>
              </div>

              {editingIdeaId === idea.id ? (
                <form onSubmit={(event) => handleEditSubmit(event, idea.id)} className="space-y-3 rounded-lg border border-amber-200/70 bg-amber-50/40 p-4 dark:border-amber-400/20 dark:bg-amber-400/5">
                  <div className="space-y-1">
                    <label htmlFor={`idea-title-${idea.id}`} className="text-sm font-medium text-amber-900 dark:text-amber-100">
                      Title
                    </label>
                    <input
                      id={`idea-title-${idea.id}`}
                      value={editTitle}
                      onChange={(event) => setEditTitle(event.target.value)}
                      className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
                      maxLength={255}
                      disabled={savingIdeaId === idea.id}
                    />
                  </div>
                  <div className="space-y-1">
                    <label htmlFor={`idea-body-${idea.id}`} className="text-sm font-medium text-amber-900 dark:text-amber-100">
                      Notes
                    </label>
                    <textarea
                      id={`idea-body-${idea.id}`}
                      value={editBody}
                      onChange={(event) => setEditBody(event.target.value)}
                      rows={4}
                      className="w-full rounded-md border px-3 py-2 text-sm dark:bg-zinc-800"
                      disabled={savingIdeaId === idea.id}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-amber-900 dark:text-amber-100">
                      Attachments
                    </label>
                    <AttachmentDropzone
                      files={editFiles}
                      error={editFileError}
                      disabled={savingIdeaId === idea.id}
                      onAddFiles={addEditFiles}
                      onRemoveFile={removeEditFile}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="submit"
                      disabled={savingIdeaId === idea.id || editTitle.trim().length === 0}
                      className="cursor-pointer rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
                    >
                      {savingIdeaId === idea.id ? "Saving..." : "Save changes"}
                    </button>
                    <button
                      type="button"
                      onClick={cancelEditing}
                      disabled={savingIdeaId === idea.id}
                      className="cursor-pointer rounded-md border px-3 py-2 text-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800"
                    >
                      Cancel
                    </button>
                    {editError && (
                      <p className="text-sm text-red-600 dark:text-red-400">{editError}</p>
                    )}
                  </div>
                </form>
              ) : (
                <>
                  {idea.body && (
                    <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
                      {idea.body}
                    </p>
                  )}

                  {savedIdeaId === idea.id && (
                    <p className="text-sm text-green-600 dark:text-green-400">Saved</p>
                  )}

                  <AttachmentsPanel scope="idea" id={idea.id} hiveId={hiveId} />
                </>
              )}

              {idea.aiAssessment && (
                <div className="rounded-md border border-amber-200/70 bg-amber-50/60 p-3 text-sm text-amber-950 dark:border-amber-400/20 dark:bg-amber-400/5 dark:text-amber-100">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-[0.18em] text-amber-700/80 dark:text-amber-300/70">
                    AI assessment
                  </p>
                  <p className="whitespace-pre-wrap">{idea.aiAssessment}</p>
                </div>
              )}

              {idea.promotedToGoalId && (
                <Link
                  href={`/goals/${idea.promotedToGoalId}`}
                  className="inline-flex text-sm font-medium text-amber-900 underline-offset-4 hover:underline dark:text-amber-100"
                >
                  Promoted to goal {idea.promotedToGoalId}
                </Link>
              )}

              {isEditable(idea) && editingIdeaId !== idea.id && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => beginEditing(idea)}
                    disabled={pendingActionId === idea.id}
                    className="cursor-pointer rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleArchive(idea.id)}
                    disabled={pendingActionId === idea.id}
                    className="cursor-pointer rounded-md border px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800"
                  >
                    {pendingActionId === idea.id ? "Working..." : "Archive"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePromote(idea)}
                    disabled={pendingActionId === idea.id}
                    className="cursor-pointer rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {pendingActionId === idea.id ? "Working..." : "Promote now"}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
