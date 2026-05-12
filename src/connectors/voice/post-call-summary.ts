import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  voiceSessions,
  voiceSessionEvents,
} from "@/db/schema/voice-sessions";
import { sql } from "@/app/api/_lib/db";
import { requestExternalAction } from "@/actions/external-actions";

/**
 * Discord's per-message character cap. We leave ~200 chars of headroom for
 * the header line, so the transcript body itself is capped at ~1800.
 */
const DISCORD_MESSAGE_CAP = 2000;
const BODY_CAP = 1800;
const TRUNCATION_SUFFIX =
  "\n… (transcript truncated — full log in the dashboard)";

export interface PostCallSummaryInput {
  startedAt: Date;
  endedAt: Date;
  entries: { role: "user" | "assistant"; text: string }[];
}

/**
 * Pure formatter: turns a voice session's start/end timestamps + transcript
 * entries into the Discord message body the EA channel receives after a call
 * ends. Truncates the body to stay under Discord's 2000-char cap and appends
 * a marker when truncated. Never throws.
 */
export function buildPostCallSummary(input: PostCallSummaryInput): string {
  const ms = Math.max(
    0,
    input.endedAt.getTime() - input.startedAt.getTime(),
  );
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  const header = `📞 **Call transcript** — ${input.startedAt.toLocaleString()} (${mins} min ${String(secs).padStart(2, "0")} sec)`;
  const rawBody = input.entries
    .map((e) => `${e.role === "user" ? "You" : "EA"}: ${e.text}`)
    .join("\n");

  let body = rawBody;
  let truncated = false;
  if (body.length > BODY_CAP) {
    body = body.slice(0, BODY_CAP);
    truncated = true;
  }

  let message = `${header}\n\n${body}`;
  if (truncated) {
    message += TRUNCATION_SUFFIX;
  }
  // Defense-in-depth: if the header itself was absurdly long, still enforce
  // the hard cap so Discord never rejects the POST.
  if (message.length > DISCORD_MESSAGE_CAP) {
    message = message.slice(0, DISCORD_MESSAGE_CAP);
  }
  return message;
}

interface EaDiscordInstall {
  installId: string;
  channelId: string;
}

/**
 * Loads the active `ea-discord` connector install for `hiveId` and returns
 * the install/channel needed to request a governed outbound message.
 */
async function loadEaDiscordInstall(
  hiveId: string,
): Promise<EaDiscordInstall | null> {
  const rows = (await sql`
    SELECT id, config
    FROM connector_installs
    WHERE connector_slug = 'ea-discord'
      AND status = 'active'
      AND hive_id = ${hiveId}
    LIMIT 1
  `) as unknown as {
    id: string;
    config: { channelId?: string };
  }[];

  const install = rows[0];
  if (!install) return null;
  const channelId = install.config?.channelId;
  if (!channelId) return null;
  return { installId: install.id, channelId };
}

async function claimPostCallSummaryPost(sessionId: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE voice_sessions
    SET post_call_summary_posted_at = now()
    WHERE id = ${sessionId}
      AND post_call_summary_posted_at IS NULL
    RETURNING id
  `) as unknown as { id: string }[];

  return rows.length > 0;
}

/**
 * Posts a formatted post-call transcript summary to the hive's ea-discord
 * channel. Fire-and-log: never throws past its own boundary, because the
 * voice runtime calls this from a `finally` on call hang-up and must not
 * block tear-down or propagate errors into the state machine.
 */
export async function postCallSummary(
  hiveId: string,
  sessionId: string,
): Promise<void> {
  try {
    const [session] = await db
      .select({
        id: voiceSessions.id,
        startedAt: voiceSessions.startedAt,
        endedAt: voiceSessions.endedAt,
      })
      .from(voiceSessions)
      .where(eq(voiceSessions.id, sessionId))
      .limit(1);
    if (!session) {
      console.error(
        `[voice] post-call summary: session ${sessionId} not found`,
      );
      return;
    }

    const events = await db
      .select({
        kind: voiceSessionEvents.kind,
        text: voiceSessionEvents.text,
      })
      .from(voiceSessionEvents)
      .where(eq(voiceSessionEvents.sessionId, sessionId))
      .orderBy(asc(voiceSessionEvents.at));

    const entries: { role: "user" | "assistant"; text: string }[] = [];
    for (const ev of events) {
      if (ev.kind === "user_phrase" && ev.text) {
        entries.push({ role: "user", text: ev.text });
      } else if (ev.kind === "ea_phrase" && ev.text) {
        entries.push({ role: "assistant", text: ev.text });
      }
    }

    const message = buildPostCallSummary({
      startedAt: session.startedAt,
      endedAt: session.endedAt ?? new Date(),
      entries,
    });

    const install = await loadEaDiscordInstall(hiveId);
    if (!install) {
      console.error(
        `[voice] post-call summary: no active ea-discord install for hive ${hiveId}; skipping.`,
      );
      return;
    }

    const claimed = await claimPostCallSummaryPost(sessionId);
    if (!claimed) return;

    const result = await requestExternalAction(sql, {
      hiveId,
      installId: install.installId,
      operation: "send_channel",
      args: { content: message },
      actor: { type: "system", id: "voice-post-call-summary" },
    });

    if (result.status !== "succeeded") {
      console.error(
        `[voice] post-call summary Discord action ${result.status}: ${result.error ?? result.policyReason}`,
      );
    }
  } catch (err) {
    console.error("[voice] post-call summary failed:", err);
  }
}
