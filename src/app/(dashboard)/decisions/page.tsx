"use client";

import { useEffect, useState, useCallback } from "react";
import type { ButtonHTMLAttributes } from "react";
import { useHiveContext } from "@/components/hive-context";
import { RunsTable, type RunsTableBadgeTone, type RunsTableRow } from "@/components/runs-table";

type Decision = {
  id: string;
  title: string;
  context: string;
  recommendation: string | null;
  options?: unknown;
  selectedOptionKey?: string | null;
  selectedOptionLabel?: string | null;
  priority: string;
  status: string;
  kind: string;
  createdAt: string;
  /** EA's plain-English reasoning. Set after the EA decides. */
  eaReasoning?: string | null;
  /** Number of EA-resolution attempts. */
  eaAttempts?: number;
  /** Timestamp of the EA's most recent action on this decision. */
  eaDecidedAt?: string | null;
};

type StatusFilter = "pending" | "ea_review" | "auto_approved";

type DecisionMessage = {
  id: string;
  sender: string;
  content: string;
  createdAt: string;
};

type DecisionActivityEntry = {
  id: string;
  timestamp: string;
  actor: string;
  summary: string;
  sourceType: string;
  sourceId: string;
};

type DecisionOption = {
  key: string;
  label: string;
  response: string;
  description: string | null;
};

const KIND_FILTERS: Array<{ value: "decision" | "system_error"; label: string }> = [
  { value: "decision", label: "Needs your call" },
  { value: "system_error", label: "System errors" },
];

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string; title: string }> = [
  {
    value: "pending",
    label: "Needs you",
    title: "Only decisions the EA has decided need your attention.",
  },
  {
    value: "ea_review",
    label: "EA handling",
    title: "Decisions the EA is currently working on. You can watch over its shoulder here.",
  },
  {
    value: "auto_approved",
    label: "Auto-approved",
    title: "Tier-2 decisions the system took without asking, rolling log.",
  },
];

const DIRECT_TASK_QA_CAP_ACTIONS = new Set([
  "retry_with_different_role",
  "refine_brief_and_retry",
  "abandon",
]);

function stringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function inferOptionResponse(key: string): string {
  if (ACTION_MAP[key]) return ACTION_MAP[key];
  if (DIRECT_TASK_QA_CAP_ACTIONS.has(key)) return key;
  if (/reject|dismiss|decline|cancel|abandon|drop|defer/i.test(key)) return "rejected";
  if (/discuss|clarify/i.test(key)) return "discussed";
  return "approved";
}

function getDecisionOptions(value: unknown): DecisionOption[] {
  const optionList = Array.isArray(value)
    ? value
    : value && typeof value === "object" && !Array.isArray(value) &&
        Array.isArray((value as { options?: unknown }).options)
      ? (value as { options: unknown[] }).options
      : [];

  return optionList.flatMap((option, index): DecisionOption[] => {
    if (typeof option === "string") {
      const label = option.trim();
      return label ? [{ key: label, label, response: "approved", description: null }] : [];
    }
    if (!option || typeof option !== "object" || Array.isArray(option)) return [];
    const record = option as Record<string, unknown>;
    const key = stringField(record, ["key", "optionKey", "action", "id", "value"]) ?? `option_${index + 1}`;
    const label = stringField(record, ["label", "title", "name"]) ?? key;
    const explicitResponse = stringField(record, ["response", "canonicalResponse", "canonical_response"]);
    const response = explicitResponse ?? inferOptionResponse(key);
    const description = stringField(record, ["consequence", "description", "summary", "detail"]);
    return [{ key, label, response, description }];
  });
}

function isDirectTaskQaCapDecision(value: unknown) {
  return !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "direct_task_qa_cap_recovery";
}

const PRIORITY_TONE: Record<string, RunsTableBadgeTone> = {
  urgent: "red",
  high: "amber",
  normal: "neutral",
  low: "neutral",
};

const ACTION_MAP: Record<string, string> = {
  approve: "approved",
  reject: "rejected",
  discuss: "discussed",
};

function FilterBar<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ value: T; label: string; title?: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[0.68rem] font-semibold uppercase text-amber-900/55 dark:text-zinc-500">
        {label}
      </p>
      <div className="flex gap-1 overflow-x-auto rounded-lg border border-amber-200/70 bg-amber-50/70 p-1 shadow-sm shadow-amber-950/5 dark:border-white/[0.08] dark:bg-white/[0.035]">
        {options.map((option) => {
          const active = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              title={option.title}
              className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-amber-500 text-zinc-950 shadow-sm shadow-amber-950/10 dark:bg-amber-300 dark:text-zinc-950"
                  : "text-amber-950/70 hover:bg-amber-100/70 hover:text-amber-950 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-amber-100"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ActionButton({
  children,
  tone = "neutral",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "neutral" | "approve" | "reject" | "primary";
}) {
  const toneClass = {
    neutral:
      "border border-amber-200/70 bg-amber-50 text-amber-950 hover:bg-amber-100 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-zinc-200 dark:hover:bg-white/[0.08]",
    approve:
      "border border-emerald-300/30 bg-emerald-500/15 text-emerald-900 hover:bg-emerald-500/25 dark:text-emerald-100",
    reject:
      "border border-red-300/30 bg-red-500/15 text-red-900 hover:bg-red-500/25 dark:text-red-100",
    primary:
      "border border-amber-300/40 bg-amber-400 text-zinc-950 hover:bg-amber-300 dark:bg-amber-300 dark:hover:bg-amber-200",
  }[tone];

  return (
    <button
      {...props}
      className={`rounded-md px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${toneClass} ${props.className ?? ""}`}
    >
      {children}
    </button>
  );
}

export default function DecisionsPage() {
  const { selected, loading: bizLoading } = useHiveContext();
  const selectedHiveId = selected?.id;
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [responding, setResponding] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [kindFilter, setKindFilter] = useState<"decision" | "system_error">("decision");
  const [expandedThread, setExpandedThread] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<DecisionMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [newMessage, setNewMessage] = useState("");
  const [activityRefresh, setActivityRefresh] = useState(0);

  const fetchDecisions = useCallback(async () => {
    if (!selectedHiveId) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/decisions?status=${statusFilter}&kind=${kindFilter}&hiveId=${selectedHiveId}`,
      );
      if (!res.ok) throw new Error("Failed to fetch decisions");
      const data = await res.json();
      setDecisions(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [selectedHiveId, statusFilter, kindFilter]);

  useEffect(() => {
    if (selectedHiveId) fetchDecisions();
  }, [fetchDecisions, selectedHiveId]);

  async function respond(id: string, action: string, note?: string, option?: DecisionOption) {
    setResponding(id);
    try {
      const response = option?.response ?? ACTION_MAP[action] ?? action;
      const res = await fetch(`/api/decisions/${id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response,
          comment: note,
          selectedOptionKey: option?.key,
          selectedOptionLabel: option?.label,
        }),
      });
      if (!res.ok) throw new Error("Failed to respond");
      setDecisions((prev) => prev.filter((d) => d.id !== id));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to respond");
    } finally {
      setResponding(null);
    }
  }

  async function loadThread(decisionId: string) {
    if (expandedThread === decisionId) {
      setExpandedThread(null);
      setThreadMessages([]);
      setNewMessage("");
      return;
    }
    setExpandedThread(decisionId);
    setThreadLoading(true);
    try {
      const res = await fetch(`/api/decisions/${decisionId}/messages`);
      if (!res.ok) throw new Error("Failed to load thread");
      const data = await res.json();
      setThreadMessages(data.data ?? []);
    } catch {
      setThreadMessages([]);
    } finally {
      setThreadLoading(false);
    }
  }

  async function sendMessage(decisionId: string) {
    const content = newMessage.trim();
    if (!content) return;
    try {
      const res = await fetch(`/api/decisions/${decisionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "discussed", comment: content }),
      });
      if (!res.ok) throw new Error("Failed to send message");
      const messages = await fetch(`/api/decisions/${decisionId}/messages`);
      if (messages.ok) {
        const data = await messages.json();
        setThreadMessages(data.data ?? []);
      }
      setNewMessage("");
      setActivityRefresh((value) => value + 1);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to send message");
    }
  }

  if (bizLoading || loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Decisions</h1>
        <p className="text-zinc-500 text-sm">Loading...</p>
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Decisions</h1>
        <p className="text-zinc-400">No hive selected.</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Decisions</h1>
        <p className="text-red-600 text-sm">{error}</p>
      </div>
    );
  }

  const pageTitle = kindFilter === "decision" ? "Decisions" : "System Health";
  const emptyMessage = (() => {
    if (statusFilter === "ea_review") {
      return kindFilter === "decision"
        ? "EA has nothing in its queue right now."
        : "No system errors currently being handled by the EA.";
    }
    if (statusFilter === "auto_approved") {
      return kindFilter === "decision"
        ? "No auto-approved decisions."
        : "No resolved system errors.";
    }
    // pending
    return kindFilter === "decision"
      ? "Inbox is clear — the EA is handling everything autonomously."
      : "No system errors currently need your attention.";
  })();

  const decisionRows: RunsTableRow[] = decisions.map((decision) => {
    const structuredOptions = getDecisionOptions(decision.options);
    const isDirectTaskQaCap = isDirectTaskQaCapDecision(decision.options);

    return {
      id: decision.id,
      title: decision.title,
      href: `/decisions/${decision.id}`,
      status: { label: decision.status, tone: decision.status === "pending" ? "amber" : "neutral" },
      priority: { label: decision.priority, tone: PRIORITY_TONE[decision.priority] ?? "neutral" },
      primaryMeta: [{ label: "Kind", value: decision.kind }],
      secondaryMeta: [{ label: "Created", value: new Date(decision.createdAt).toLocaleDateString() }],
      rowClassName:
        decision.priority === "urgent"
          ? "bg-red-50/70 dark:bg-red-950/25"
          : undefined,
      expandedContent: (
        <div className="space-y-4 rounded-md border border-amber-200/50 bg-white/45 p-3 dark:border-white/[0.07] dark:bg-black/[0.12]">
          <div className="space-y-1.5">
            <p className="text-[0.68rem] font-semibold uppercase text-amber-900/55 dark:text-zinc-500">Context</p>
            <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
              {decision.context}
            </p>
          </div>

          {decision.recommendation && (
            <div className="space-y-1.5">
              <p className="text-[0.68rem] font-semibold uppercase text-amber-900/55 dark:text-zinc-500">
                Recommendation
              </p>
              <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">
                {decision.recommendation}
              </p>
            </div>
          )}

          {structuredOptions.length > 0 && (
            <div className="space-y-2">
              <p className="text-[0.68rem] font-semibold uppercase text-amber-900/55 dark:text-zinc-500">
                Options
              </p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {structuredOptions.map((option) => {
                  const canAct =
                    statusFilter === "pending" &&
                    (DIRECT_TASK_QA_CAP_ACTIONS.has(option.response) ||
                      option.response === "approved" ||
                      option.response === "rejected" ||
                      option.response === "discussed");
                  if (canAct) {
                    const isRejecting =
                      option.response === "rejected" || option.response === "abandon";
                    return (
                      <button
                        key={option.key}
                        onClick={() => respond(decision.id, option.response, undefined, option)}
                        disabled={responding === decision.id}
                        className={`min-h-20 rounded-md border px-3 py-2 text-left text-sm font-semibold transition-colors disabled:opacity-50 ${
                          isRejecting
                            ? "border-red-300/30 bg-red-500/15 text-red-900 hover:bg-red-500/25 dark:text-red-100"
                            : "border-emerald-300/30 bg-emerald-500/15 text-emerald-900 hover:bg-emerald-500/25 dark:text-emerald-100"
                        }`}
                      >
                        <span className="block">{option.label}</span>
                        {option.description && (
                          <span className="mt-1 block text-xs font-normal opacity-85">
                            {option.description}
                          </span>
                        )}
                      </button>
                    );
                  }
                  return (
                    <span
                      key={option.key}
                      className="min-h-20 rounded-md border border-amber-200/60 bg-amber-50/45 px-3 py-2 text-sm text-zinc-700 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-zinc-200"
                    >
                      <span className="block font-medium">{option.label}</span>
                      {option.description && (
                        <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">
                          {option.description}
                        </span>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {decision.eaReasoning && (
            <div className="space-y-1 rounded-md border border-amber-300/35 bg-amber-300/10 p-3">
              <p className="text-[0.68rem] font-semibold uppercase text-amber-800 dark:text-amber-200">
                EA reasoning
                {typeof decision.eaAttempts === "number" && decision.eaAttempts > 0 && (
                  <span className="ml-2 font-normal lowercase text-amber-600/70 dark:text-amber-400/60">
                    attempt {decision.eaAttempts}
                  </span>
                )}
              </p>
              <p className="whitespace-pre-wrap text-sm text-amber-900 dark:text-amber-100">
                {decision.eaReasoning}
              </p>
            </div>
          )}

          <DecisionActivity
            decisionId={decision.id}
            defaultOpen={decision.status === "pending"}
            refreshToken={activityRefresh}
          />

          <div className="flex flex-wrap gap-2 pt-1">
            {statusFilter === "ea_review" ? (
              <p className="text-xs italic text-zinc-500">
                EA is working on this. No action needed from you yet — it&apos;ll either resolve
                autonomously or escalate to the &quot;Needs you&quot; tab.
              </p>
            ) : structuredOptions.length > 0 || isDirectTaskQaCap ? (
              <ActionButton
                onClick={() => loadThread(decision.id)}
                disabled={responding === decision.id}
                tone={expandedThread === decision.id ? "primary" : "neutral"}
              >
                Discuss
              </ActionButton>
            ) : statusFilter === "auto_approved" ? (
              <ActionButton
                onClick={() => respond(decision.id, "reject")}
                disabled={responding === decision.id}
                tone="reject"
              >
                Override &amp; Reject
              </ActionButton>
            ) : (
              <>
                <ActionButton
                  onClick={() => respond(decision.id, "approve")}
                  disabled={responding === decision.id}
                  tone="approve"
                >
                  Approve
                </ActionButton>
                <ActionButton
                  onClick={() => loadThread(decision.id)}
                  disabled={responding === decision.id}
                  tone={expandedThread === decision.id ? "primary" : "neutral"}
                >
                  Discuss
                </ActionButton>
                <ActionButton
                  onClick={() => respond(decision.id, "reject")}
                  disabled={responding === decision.id}
                  tone="reject"
                >
                  Reject
                </ActionButton>
              </>
            )}
          </div>

          {expandedThread === decision.id && (
            <div className="rounded-md border border-amber-200/70 bg-amber-50/45 dark:border-white/[0.08] dark:bg-white/[0.035]">
              <div className="max-h-64 space-y-2 overflow-y-auto p-3">
                {threadLoading ? (
                  <p className="text-xs text-zinc-500">Loading thread...</p>
                ) : threadMessages.length === 0 ? (
                  <p className="text-xs text-zinc-500">No messages yet. Start the discussion below.</p>
                ) : (
                  threadMessages.map((msg) => (
                    <div
                      key={msg.id}
                      className={`rounded-md px-3 py-2 text-sm ${
                        msg.sender === "owner"
                          ? "border border-amber-300/45 bg-amber-200/25 dark:bg-amber-300/10"
                          : "border border-white/[0.08] bg-white/70 dark:bg-black/[0.18]"
                      }`}
                    >
                      <div className="mb-0.5 flex items-center gap-2">
                        <span className="text-xs font-semibold capitalize text-zinc-600 dark:text-zinc-400">
                          {msg.sender}
                        </span>
                        <span className="text-xs text-zinc-400 dark:text-zinc-500">
                          {new Date(msg.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">
                        {msg.content}
                      </p>
                    </div>
                  ))
                )}
              </div>

              <div className="flex flex-col gap-2 border-t border-amber-200/60 p-3 dark:border-white/[0.08] sm:flex-row">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage(decision.id);
                    }
                  }}
                  placeholder="Type a message..."
                  className="min-w-0 flex-1 rounded-md border border-amber-200/80 bg-white/80 px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-amber-400/70 dark:border-white/[0.1] dark:bg-black/[0.2] dark:text-zinc-100"
                />
                <ActionButton
                  onClick={() => sendMessage(decision.id)}
                  disabled={!newMessage.trim()}
                  tone="primary"
                >
                  Send
                </ActionButton>
              </div>
            </div>
          )}
        </div>
      ),
    };
  });

  return (
    <div className="space-y-6">
      <div className="hive-honey-glow flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase text-amber-800/70 dark:text-amber-200/70">
            Decision operations
          </p>
          <h1 className="text-2xl font-semibold">{pageTitle}</h1>
        </div>
        <span className="text-sm text-zinc-500">
          {decisions.length}{" "}
          {kindFilter === "decision"
            ? statusFilter === "pending"
              ? "pending"
              : "auto-approved"
            : statusFilter === "pending"
              ? "open"
              : "resolved"}
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(14rem,0.5fr)_1fr]">
        <FilterBar
          label="Queue"
          options={KIND_FILTERS}
          value={kindFilter}
          onChange={setKindFilter}
        />
        <FilterBar
          label="Status"
          options={STATUS_FILTERS}
          value={statusFilter}
          onChange={setStatusFilter}
        />
      </div>

      <RunsTable
        rows={decisionRows}
        emptyState={emptyMessage}
        ariaLabel="Decisions list"
        columns={{
          title: "Decision",
          primaryMeta: "Kind",
          status: "Status",
          priority: "Priority",
          secondaryMeta: "Created",
        }}
      />
    </div>
  );
}

function DecisionActivity({
  decisionId,
  defaultOpen,
  refreshToken,
}: {
  decisionId: string;
  defaultOpen: boolean;
  refreshToken: number;
}) {
  const [entries, setEntries] = useState<DecisionActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/decisions/${decisionId}/activity`)
      .then((res) => (res.ok ? res.json() : { data: [] }))
      .then((body) => {
        if (!cancelled) setEntries(Array.isArray(body.data) ? body.data : []);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [decisionId, refreshToken]);

  return (
    <details
      open={defaultOpen}
      className="rounded-md border border-zinc-200 bg-zinc-50/80 p-3 dark:border-zinc-700 dark:bg-zinc-800/40"
    >
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-300">
        Activity
      </summary>
      <div className="mt-3 space-y-3">
        {loading ? (
          <p className="text-xs text-zinc-500">Loading activity...</p>
        ) : entries.length === 0 ? (
          <p className="text-xs text-zinc-500">No activity recorded yet.</p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="grid gap-1 border-l-2 border-amber-300 pl-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold capitalize text-zinc-700 dark:text-zinc-200">
                  {entry.actor}
                </span>
                <span className="text-zinc-400">{new Date(entry.timestamp).toLocaleString()}</span>
                <span className="font-mono text-[11px] text-zinc-400">
                  {entry.sourceType}:{entry.sourceId.slice(0, 8)}
                </span>
              </div>
              <p className="text-sm text-zinc-700 dark:text-zinc-300">{entry.summary}</p>
            </div>
          ))
        )}
      </div>
    </details>
  );
}
