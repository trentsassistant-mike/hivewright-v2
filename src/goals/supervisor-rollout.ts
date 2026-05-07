import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";

/**
 * Reads codex JSONL rollout files for a goal supervisor and parses them into
 * a flat timeline of human-readable events: assistant messages, tool calls,
 * tool outputs, status changes.
 *
 * The supervisor lifecycle parks its conversation as a codex thread so the
 * supervisor "process" is only alive during planning + wake-up runs. Each
 * run produces a separate rollout file under
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<UUID>.jsonl
 *
 * The very first run's filename UUID matches the thread_id stored in
 * `<workspace>/.codex-thread-id`. Wake-up runs created via
 * `codex exec resume <thread_id>` reuse the same conversation but produce
 * fresh rollout files (different UUIDs) — these are linked back via the
 * `session_meta.payload.id` field referencing the resumed thread.
 *
 * For now we surface the original-thread file only; multi-run aggregation
 * across wake-ups is a follow-up.
 */

const SESSIONS_DIR = path.join(process.env.HOME ?? os.homedir(), ".codex", "sessions");

export type SupervisorEventType =
  | "session_meta"
  | "assistant_message"
  | "reasoning"
  | "tool_call"
  | "tool_output"
  | "user_message"
  | "other";

export interface SupervisorEvent {
  ts: string;
  type: SupervisorEventType;
  /** Short human-readable label. */
  label: string;
  /** Body content — already truncated to a sane length for display. */
  body: string;
  /** Original event-type string from the rollout (for debugging / future filters). */
  raw?: string;
}

export interface SupervisorActivity {
  threadId: string | null;
  workspacePath: string;
  rolloutPath: string | null;
  /** Last time the rollout file changed on disk (ISO 8601). */
  lastActivityAt: string | null;
  /** True when the file was modified in the last 30 s — supervisor is probably running. */
  active: boolean;
  events: SupervisorEvent[];
}

const MAX_BODY_CHARS = 1200;

function truncate(s: string, n = MAX_BODY_CHARS): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n[… ${(s.length / 1024).toFixed(1)} KB truncated]`;
}

function readThreadId(workspacePath: string): string | null {
  try {
    const p = path.join(workspacePath, ".codex-thread-id");
    return fs.readFileSync(p, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Find the original rollout file for a thread by suffix-match on the filename.
 * Codex names initial-run files `rollout-<ts>-<thread_id>.jsonl`.
 */
function findRolloutFile(threadId: string): string | null {
  if (!fs.existsSync(SESSIONS_DIR)) return null;

  // Walk YYYY/MM/DD subdirs; rollout files are leaf-only.
  const candidates: { p: string; mtimeMs: number }[] = [];

  function walk(dir: string, depth: number) {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith(`-${threadId}.jsonl`)) {
        try {
          const st = fs.statSync(full);
          candidates.push({ p: full, mtimeMs: st.mtimeMs });
        } catch { /* skip */ }
      }
    }
  }

  walk(SESSIONS_DIR, 0);
  if (candidates.length === 0) return null;
  // Prefer the most recently modified one (handles edge cases; usually only one).
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].p;
}

interface ResponseItemPayload {
  type?: string;
  role?: string;
  content?: { type?: string; text?: string }[];
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: string;
  summary?: { type?: string; text?: string }[];
}

interface RolloutLine {
  timestamp?: string;
  type?: string;
  payload?: ResponseItemPayload | Record<string, unknown>;
}

function extractAssistantText(payload: ResponseItemPayload): string {
  const parts = payload.content ?? [];
  return parts
    .map((c) => c.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function extractReasoningText(payload: ResponseItemPayload): string {
  // codex reasoning items hold their visible text under `summary[].text`
  const summary = payload.summary ?? [];
  return summary
    .map((s) => s.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function summariseToolCall(payload: ResponseItemPayload): { label: string; body: string } {
  const name = payload.name ?? "tool";
  let body = payload.arguments ?? "";
  // Tool args are JSON; try to pull out the most informative single field.
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.cmd === "string") body = parsed.cmd;
    else if (typeof parsed.command === "string") body = parsed.command;
  } catch { /* not JSON, fall through */ }
  return { label: name, body };
}

function summariseToolOutput(payload: ResponseItemPayload): { body: string } {
  let raw = payload.output ?? "";
  // codex sometimes wraps output as a JSON envelope { output: { content: ..., metadata: ... } }
  try {
    const parsed = JSON.parse(raw) as { output?: string; content?: string };
    if (typeof parsed.output === "string") raw = parsed.output;
    else if (typeof parsed.content === "string") raw = parsed.content;
  } catch { /* keep raw */ }
  return { body: raw };
}

async function parseRolloutFile(rolloutPath: string): Promise<SupervisorEvent[]> {
  const events: SupervisorEvent[] = [];
  const stream = fs.createReadStream(rolloutPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let ev: RolloutLine;
    try {
      ev = JSON.parse(line) as RolloutLine;
    } catch {
      continue;
    }
    const ts = ev.timestamp ?? "";

    if (ev.type === "session_meta") {
      events.push({
        ts,
        type: "session_meta",
        label: "session started",
        body: "",
        raw: ev.type,
      });
      continue;
    }

    if (ev.type !== "response_item" || !ev.payload) continue;
    const p = ev.payload as ResponseItemPayload;

    if (p.type === "message" && p.role === "assistant") {
      const text = extractAssistantText(p);
      if (!text) continue;
      events.push({ ts, type: "assistant_message", label: "thinking", body: truncate(text), raw: "message:assistant" });
      continue;
    }

    if (p.type === "message" && p.role === "user") {
      const text = extractAssistantText(p);
      if (!text) continue;
      // The injected AGENTS.md / wake-up prompt is fired as a "user" message
      // — surface only the first ~400 chars so the timeline isn't dominated
      // by the framing prompt.
      events.push({ ts, type: "user_message", label: "system input", body: truncate(text, 400), raw: "message:user" });
      continue;
    }

    if (p.type === "reasoning") {
      const text = extractReasoningText(p);
      if (!text) continue;
      events.push({ ts, type: "reasoning", label: "reasoning", body: truncate(text), raw: "reasoning" });
      continue;
    }

    if (p.type === "function_call") {
      const { label, body } = summariseToolCall(p);
      events.push({ ts, type: "tool_call", label, body: truncate(body), raw: "function_call" });
      continue;
    }

    if (p.type === "function_call_output") {
      const { body } = summariseToolOutput(p);
      if (!body.trim()) continue;
      events.push({ ts, type: "tool_output", label: "result", body: truncate(body), raw: "function_call_output" });
      continue;
    }
  }

  return events;
}

export async function loadSupervisorActivity(workspacePath: string): Promise<SupervisorActivity> {
  const threadId = readThreadId(workspacePath);
  const empty: SupervisorActivity = {
    threadId,
    workspacePath,
    rolloutPath: null,
    lastActivityAt: null,
    active: false,
    events: [],
  };

  if (!threadId) return empty;

  const rolloutPath = findRolloutFile(threadId);
  if (!rolloutPath) return { ...empty, threadId };

  let mtimeMs = 0;
  try {
    const st = fs.statSync(rolloutPath);
    mtimeMs = st.mtimeMs;
  } catch {
    return { ...empty, threadId, rolloutPath };
  }

  const events = await parseRolloutFile(rolloutPath);
  const lastActivityAt = new Date(mtimeMs).toISOString();
  const active = Date.now() - mtimeMs < 30_000;

  return {
    threadId,
    workspacePath,
    rolloutPath,
    lastActivityAt,
    active,
    events,
  };
}
