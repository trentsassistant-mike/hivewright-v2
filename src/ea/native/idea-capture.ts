import type { Sql } from "postgres";
import {
  appendMessage,
  getOrCreateActiveThread,
} from "./thread-store";
import { scheduleImplicitQualityExtraction } from "@/quality/ea-post-turn";

// Owner-typed prefixes that route a Discord DM straight into the ideas
// backlog instead of through the EA's reasoning/delegation flow. Lowercase
// here — matching is case-insensitive at the start of the message.
const IDEA_PREFIXES = ["add idea:", "park this:", "idea:"] as const;

const TITLE_MAX = 255;

export interface ParsedIdeaCapture {
  /** Lowercased prefix that matched (e.g. "idea:"). */
  prefix: string;
  /** First non-empty line after the prefix, capped at the column limit. */
  title: string;
  /** Remaining lines, or null if the user only typed a single-line title. */
  body: string | null;
}

/**
 * Detect an explicit idea-capture command at the start of an owner message.
 * Returns null when the message isn't a capture (preserving the existing
 * EA reasoning/delegation flow) so the caller can branch cleanly.
 */
export function parseIdeaCapture(message: string): ParsedIdeaCapture | null {
  const trimmed = message.replace(/^\s+/, "");
  const lower = trimmed.toLowerCase();
  // Longer prefixes are tried first ("add idea:" before "idea:") so that
  // "add idea: foo" doesn't collapse into title="dea: foo".
  for (const prefix of IDEA_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const rest = trimmed.slice(prefix.length).trim();
      if (rest.length === 0) return null;

      const newlineIdx = rest.indexOf("\n");
      let title: string;
      let body: string | null;
      if (newlineIdx === -1) {
        title = rest;
        body = null;
      } else {
        title = rest.slice(0, newlineIdx).trim();
        const tail = rest.slice(newlineIdx + 1).trim();
        body = tail.length > 0 ? tail : null;
        if (title.length === 0) {
          // Owner started the body on the line after the prefix — promote
          // the first non-empty line to the title so we never persist a
          // blank title (the column is NOT NULL).
          const lines = rest.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 0);
          if (lines.length === 0) return null;
          title = lines[0];
          const remainder = lines.slice(1).join("\n").trim();
          body = remainder.length > 0 ? remainder : null;
        }
      }

      if (title.length > TITLE_MAX) {
        const overflow = title.slice(TITLE_MAX);
        title = title.slice(0, TITLE_MAX);
        body = body !== null ? `${overflow}\n\n${body}` : overflow;
      }

      return { prefix, title, body };
    }
  }
  return null;
}

export interface CapturedIdea {
  id: string;
}

/**
 * Persist an EA-captured idea through the real ideas API path, authenticated
 * as an internal system-owner session and attributed as `created_by='ea'`
 * via `X-System-Role: ea`.
 */
export async function captureEaIdea(
  sql: Sql,
  hiveId: string,
  apiBaseUrl: string,
  parsed: ParsedIdeaCapture,
): Promise<CapturedIdea> {
  void sql;
  const token = process.env.INTERNAL_SERVICE_TOKEN;
  if (!token) {
    throw new Error("INTERNAL_SERVICE_TOKEN is required for EA idea capture");
  }
  const res = await fetch(new URL(`/api/hives/${hiveId}/ideas`, apiBaseUrl), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-System-Role": "ea",
    },
    body: JSON.stringify({
      title: parsed.title,
      body: parsed.body,
    }),
  });

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // Leave payload as null so the error path below stays readable.
  }

  if (!res.ok) {
    const detail =
      payload !== null && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : `HTTP ${res.status}`;
    throw new Error(`failed to capture idea via API: ${detail}`);
  }

  const ideaId =
    payload !== null &&
    typeof payload === "object" &&
    "data" in payload &&
    payload.data !== null &&
    typeof payload.data === "object" &&
    "id" in payload.data &&
    typeof payload.data.id === "string"
      ? payload.data.id
      : null;

  if (ideaId === null) {
    throw new Error("failed to capture idea via API: missing idea id in response");
  }

  return { id: ideaId };
}

export function buildIdeaCaptureConfirmation(ideaId: string): string {
  return `Parked as idea ${ideaId} — will surface in tomorrow's review.`;
}

export interface IdeaCaptureOutcome {
  ideaId: string;
  reply: string;
}

/**
 * Full DM-to-idea flow, decoupled from Discord so it's testable end-to-end.
 * Returns null when the message isn't a prefixed capture, leaving the
 * caller free to fall through to the standard EA reasoning path. When a
 * capture happens we still record the owner message + assistant reply on
 * the active thread so the conversation log stays continuous.
 */
export async function handleIdeaCaptureMessage(
  sql: Sql,
  hiveId: string,
  apiBaseUrl: string,
  channelId: string,
  content: string,
  discordMessageId: string | null = null,
): Promise<IdeaCaptureOutcome | null> {
  const parsed = parseIdeaCapture(content);
  if (parsed === null) return null;

  const thread = await getOrCreateActiveThread(sql, hiveId, channelId);
  const ownerMessage = await appendMessage(sql, thread.id, "owner", content, discordMessageId);
  const captured = await captureEaIdea(sql, hiveId, apiBaseUrl, parsed);
  const reply = buildIdeaCaptureConfirmation(captured.id);
  await appendMessage(sql, thread.id, "assistant", reply);
  scheduleImplicitQualityExtraction(sql, {
    hiveId,
    ownerMessage: content,
    ownerMessageId: ownerMessage.id,
  });
  return { ideaId: captured.id, reply };
}
