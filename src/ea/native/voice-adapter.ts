import { sql } from "@/app/api/_lib/db";
import {
  appendMessage,
  getOrCreateActiveThread,
  getThreadMessages,
} from "./thread-store";
import { buildEaPrompt } from "./prompt";
import { runEaStream } from "./runner";
import { VOICE_MODE_PROMPT_SUFFIX } from "@/connectors/voice/prompt";
import { assessBudget } from "@/voice/budget";
import { scheduleImplicitQualityExtraction } from "@/quality/ea-post-turn";

/**
 * EA voice adapter — the glue between a live voice session runtime and
 * the native EA's existing thread + prompt machinery.
 *
 * Shape:
 *   eaVoiceClient.submit(text, { sessionId, hiveId })
 *     → AsyncIterable<string> of assistant text chunks (for TTS).
 *
 * Responsibilities on each turn:
 * 1. Resolve an EA thread keyed on `voice:<sessionId>` so every turn in
 *    the same call shares history, and a `/new` on Discord can't
 *    accidentally wipe an in-flight voice call (separate channel key).
 * 2. Persist the owner's utterance as an `ea_messages` row tagged
 *    `source='voice'` + `voice_session_id=<sessionId>` BEFORE the
 *    stream starts so the next turn's history query sees it.
 * 3. Build the same EA prompt the Discord connector uses, then append
 *    the voice-mode suffix that teaches the EA to speak (not write).
 * 4. Stream chunks to the caller, accumulate, and persist the assistant
 *    reply only once the stream is fully consumed (single final row,
 *    matching the Discord flow's "one message per turn" shape).
 */

const DEFAULT_API_BASE_URL = "http://localhost:3002";

export interface EaVoiceSubmitContext {
  sessionId: string;
  hiveId: string;
}

export interface EaVoiceClient {
  submit(
    text: string,
    ctx: EaVoiceSubmitContext,
  ): Promise<AsyncIterable<string>>;
}

export const eaVoiceClient: EaVoiceClient = {
  async submit(text, ctx) {
    const thread = await getOrCreateActiveThread(
      sql,
      ctx.hiveId,
      `voice:${ctx.sessionId}`,
    );

    // Persist the owner utterance before prompt-build so the next turn's
    // history reflects what the user said, even if prompt-build or
    // streaming fails downstream. Callers should handle thrown errors
    // and not assume an assistant reply follows.
    const ownerMessage = await appendMessage(
      sql,
      thread.id,
      "owner",
      text,
      null,
      "voice",
      ctx.sessionId,
    );

    const [hive] = await sql<{ name: string }[]>`
      SELECT name FROM hives WHERE id = ${ctx.hiveId}
    `;
    const history = await getThreadMessages(sql, thread.id);
    const apiBaseUrl = process.env.NEXT_PUBLIC_APP_URL ?? DEFAULT_API_BASE_URL;

    const basePrompt = await buildEaPrompt(sql, {
      hiveId: ctx.hiveId,
      hiveName: hive?.name ?? "unknown",
      history,
      currentOwnerMessage: text,
      apiBaseUrl,
      auditContext: {
        source: "voice",
        sourceHiveId: ctx.hiveId,
        threadId: thread.id,
        ownerMessageId: ownerMessage.id,
      },
    });

    // Budget gate. Load the `voice-ea` connector install for this hive
    // to read the optional monthly LLM-cost cap. No install or a zero
    // cap means "no cap configured" — skip the check entirely.
    const [install] = await sql<{ config: Record<string, unknown> | null }[]>`
      SELECT config FROM connector_installs
      WHERE hive_id = ${ctx.hiveId}
        AND connector_slug = 'voice-ea'
        AND status = 'active'
      LIMIT 1
    `;
    const cap = install
      ? Number(
          (install.config as Record<string, unknown> | null)?.maxMonthlyLlmCents,
        ) || 0
      : 0;
    const budget =
      cap > 0 ? await assessBudget(ctx.hiveId, { monthlyLlmCap: cap }) : null;

    if (budget?.pause) {
      // Terminal: don't spend another LLM call this turn. Persist the
      // apology so it's in history for post-call review, then return a
      // one-shot async iterable with the sentence for TTS to read.
      const pauseMessage =
        "You've hit your monthly voice budget. Hanging up — check the Voice settings page to raise the cap if you'd like to keep going.";
      await appendMessage(
        sql,
        thread.id,
        "assistant",
        pauseMessage,
        undefined,
        "voice",
        ctx.sessionId,
      );
      scheduleImplicitQualityExtraction(sql, {
        hiveId: ctx.hiveId,
        ownerMessage: text,
        ownerMessageId: ownerMessage.id,
      });
      return (async function* () {
        yield pauseMessage;
      })();
    }

    const warnBanner = budget?.warn
      ? `\n## Budget warning\n\nMonthly voice-LLM spend: ${budget.spendCents}¢ of ${budget.capCents}¢. Mention this briefly at the START of your next reply, then continue with the owner's request.\n`
      : "";
    const fullPrompt = `${basePrompt}\n${VOICE_MODE_PROMPT_SUFFIX}${warnBanner}`;

    const stream = runEaStream(fullPrompt);

    return (async function* () {
      let accumulated = "";
      try {
        for await (const chunk of stream) {
          accumulated += chunk;
          yield chunk;
        }
      } finally {
        // Persist whatever we did accumulate — even on error we want the
        // partial utterance visible in history for the next turn and for
        // post-call review. Empty replies are still inserted so message
        // ordering stays consistent with the Discord flow.
        await appendMessage(
          sql,
          thread.id,
          "assistant",
          accumulated,
          null,
          "voice",
          ctx.sessionId,
        );
        scheduleImplicitQualityExtraction(sql, {
          hiveId: ctx.hiveId,
          ownerMessage: text,
          ownerMessageId: ownerMessage.id,
        });
      }
    })();
  },
};
