"use client";

import { useEffect, useState } from "react";
import { useHiveContext } from "@/components/hive-context";

interface Turn {
  member_slug: string;
  member_name: string;
  content: string;
  order_index: number;
}

interface SessionSummary {
  id: string;
  question: string;
  status: string;
  recommendation: string | null;
  created_at: string;
}

export default function BoardPage() {
  const { selected } = useHiveContext();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<{
    session: SessionSummary;
    turns: Turn[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reloadSessions(hiveId: string) {
    const res = await fetch(`/api/board/sessions?hiveId=${hiveId}`);
    const body = await res.json();
    setSessions(body.data ?? []);
  }

  useEffect(() => {
    if (!selected?.id) {
      setSessions([]);
      return;
    }
    void reloadSessions(selected.id);
  }, [selected?.id]);

  async function openSession(id: string) {
    const res = await fetch(`/api/board/sessions/${id}`);
    const body = await res.json();
    if (!res.ok) {
      setError(body.error ?? "Failed to load session");
      return;
    }
    setSelectedSession(body.data);
  }

  async function ask() {
    if (!selected || !question.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/board/deliberate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId: selected.id, question }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "Deliberation failed");
        return;
      }
      setQuestion("");
      await reloadSessions(selected.id);
      await openSession(body.data.sessionId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!selected) return <p className="text-muted-foreground">Select a hive first.</p>;

  return (
    <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">AI Board</h1>
          <p className="mt-1 max-w-prose text-sm leading-6 text-muted-foreground">
            Ask a strategic question. Analyst → Strategist → Risk → Accountant →
            Chair deliberate in order; the Chair synthesises the call. The full
            transcript is saved for later review.
          </p>
        </div>

        <div className="space-y-3 rounded-lg border border-border bg-card/95 p-3 text-card-foreground shadow-[0_18px_48px_rgba(0,0,0,0.18)] dark:border-white/[0.06] dark:bg-card/90 dark:shadow-[0_18px_48px_rgba(0,0,0,0.32)]">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. Should we expand Cabin Connect's marketing budget this quarter?"
            rows={5}
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-inner shadow-black/5 transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/35 dark:border-white/[0.08] dark:bg-black/20"
          />
          <button
            onClick={ask}
            disabled={busy || !question.trim()}
            className="inline-flex h-8 items-center justify-center rounded-lg border border-transparent bg-primary px-3 text-sm font-medium text-primary-foreground shadow-[0_0_0_1px_rgba(255,197,98,0.16),0_10px_26px_rgba(229,154,27,0.16)] transition-colors hover:bg-primary/90 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-50"
          >
            {busy ? "Deliberating…" : "Ask the board"}
          </button>
          {error && <p className="text-xs text-rose-300">{error}</p>}
        </div>

        <div>
          <h2 className="mb-2 text-sm font-medium text-foreground">Recent sessions</h2>
          {sessions.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border bg-muted/25 p-3 text-xs text-muted-foreground dark:border-white/[0.08] dark:bg-white/[0.025]">
              No sessions yet.
            </p>
          ) : (
            <ul className="space-y-1">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => openSession(s.id)}
                    className="block w-full truncate rounded-md px-2 py-1.5 text-left text-xs text-foreground/80 transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground dark:hover:bg-white/[0.05]"
                  >
                    <span className="mr-2 text-muted-foreground">
                      {new Date(s.created_at).toLocaleDateString()}
                    </span>
                    {s.question}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="space-y-4">
        {selectedSession ? (
          <>
            <div className="rounded-lg border border-border bg-card/95 p-4 text-card-foreground shadow-[0_18px_48px_rgba(0,0,0,0.18)] dark:border-white/[0.06] dark:bg-card/90 dark:shadow-[0_18px_48px_rgba(0,0,0,0.32)]">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Question</p>
              <p className="mt-1 break-words text-sm text-foreground">
                {selectedSession.session.question}
              </p>
              {selectedSession.session.status === "error" && (
                <p className="mt-2 text-xs text-rose-300">
                  Error: {selectedSession.session.status}
                </p>
              )}
            </div>
            {selectedSession.turns.map((t) => (
              <div
                key={`${t.order_index}-${t.member_slug}`}
                className={`rounded-lg border p-4 ${
                  t.member_slug === "chair"
                    ? "border-primary/35 bg-primary/10 text-foreground shadow-[0_18px_48px_rgba(0,0,0,0.18)]"
                    : "border-border bg-card/80 text-card-foreground shadow-[0_18px_48px_rgba(0,0,0,0.14)] dark:border-white/[0.06] dark:bg-card/70"
                }`}
              >
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t.member_name}
                </p>
                <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground/90">
                  {t.content}
                </pre>
              </div>
            ))}
          </>
        ) : (
          <p className="rounded-lg border border-dashed border-border bg-muted/25 p-6 text-center text-sm text-muted-foreground dark:border-white/[0.08] dark:bg-white/[0.025]">
            Ask a question or pick a session on the left.
          </p>
        )}
      </div>
    </div>
  );
}
