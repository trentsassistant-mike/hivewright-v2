"use client";

import { useEffect, useRef, useState } from "react";

type GoalComment = {
  id: string;
  goalId: string;
  body: string;
  createdBy: string;
  createdAt: string;
};

export function GoalCommentsPanel({ goalId }: { goalId: string }) {
  const [comments, setComments] = useState<GoalComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch(`/api/goals/${goalId}/comments`)
      .then((r) => r.json())
      .then((json) => {
        setComments(json.data?.comments ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [goalId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/goals/${goalId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: trimmed, createdBy: "owner" }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Failed to post comment");
      } else {
        setComments((prev) => [...prev, json.data.comment]);
        setBody("");
        textareaRef.current?.focus();
      }
    } catch {
      setError("Network error — please try again");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <h2 className="text-sm font-semibold text-zinc-500 uppercase tracking-wide">
        Feedback &amp; Comments
      </h2>

      {/* Comment history */}
      {loading ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No comments yet. Use the form below to request more work or provide feedback.
        </p>
      ) : (
        <ul className="space-y-3">
          {comments.map((c) => (
            <li key={c.id} className="rounded-md bg-zinc-50 dark:bg-zinc-900 p-3 space-y-1">
              <p className="text-sm whitespace-pre-wrap">{c.body}</p>
              <p className="text-xs text-zinc-400">
                {c.createdBy} ·{" "}
                {new Date(c.createdAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </p>
            </li>
          ))}
        </ul>
      )}

      {/* Composer */}
      <form onSubmit={handleSubmit} className="space-y-2">
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Request more work, flag an issue, or leave feedback…"
          rows={3}
          className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-amber-500 resize-none"
          disabled={submitting}
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={submitting || !body.trim()}
            className="rounded-md bg-amber-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? "Posting…" : "Post Comment"}
          </button>
        </div>
      </form>
    </div>
  );
}
