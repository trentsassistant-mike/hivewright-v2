import type { Sql } from "postgres";
import { sql as appSql } from "@/app/api/_lib/db";
import {
  appendMessage,
  closeActiveThread,
  getOrCreateActiveThread,
  getThreadMessages,
  type EaMessage,
  type EaThread,
} from "./thread-store";
import { buildEaPrompt } from "./prompt";
import { runEaStream } from "./runner";
import { emitEaChatEvent } from "./events";
import { scheduleImplicitQualityExtraction } from "@/quality/ea-post-turn";
import { type EaAttachment, renderEaAttachmentSection } from "./attachments";

export type DashboardChatMessage = EaMessage;

const DEFAULT_API_BASE_URL = "http://localhost:3002";

export interface DashboardChatState {
  thread: EaThread;
  messages: DashboardChatMessage[];
  hasMore: boolean;
}

export interface DashboardSendResult {
  thread: EaThread;
  threadId: string;
  ownerMessage: DashboardChatMessage;
  assistantMessage: DashboardChatMessage;
}

export class DashboardEaTurnInProgressError extends Error {
  constructor(
    readonly threadId: string,
    readonly assistantMessageId: string,
  ) {
    super("EA is already responding");
    this.name = "DashboardEaTurnInProgressError";
  }
}

export interface DashboardEaSubmitContext {
  hiveId: string;
  hiveName?: string;
  attachments?: EaAttachment[];
  signal?: AbortSignal;
}

export interface DashboardEaClient {
  submit(text: string, ctx: DashboardEaSubmitContext): Promise<AsyncIterable<string>>;
}

export function dashboardChannelId(hiveId: string): string {
  return `dashboard:${hiveId}`.slice(0, 64);
}

async function prepareDashboardTurn(
  sql: Sql,
  input: {
    hiveId: string;
    hiveName?: string;
    content: string;
    attachments?: EaAttachment[];
    signal?: AbortSignal;
  },
): Promise<{
  thread: EaThread;
  ownerMessage: EaMessage;
  stream: AsyncIterable<string>;
}> {
  const thread = await getOrCreateActiveThread(
    sql,
    input.hiveId,
    dashboardChannelId(input.hiveId),
  );

  const [running] = await sql<{ id: string }[]>`
    SELECT id
    FROM ea_messages
    WHERE thread_id = ${thread.id}
      AND role = 'assistant'
      AND status = 'streaming'
    LIMIT 1
  `;
  if (running) {
    throw new DashboardEaTurnInProgressError(thread.id, running.id);
  }
  const attachments = input.attachments ?? [];
  const attachmentSection = renderEaAttachmentSection(attachments);
  const persistedOwnerContent = attachmentSection
    ? `${input.content}\n${attachmentSection}`
    : input.content;

  const ownerMessage = await appendMessage(
    sql,
    thread.id,
    "owner",
    persistedOwnerContent,
    null,
    "dashboard",
  );
  await emitEaChatEvent(sql, {
    type: "ea_message_created",
    hiveId: input.hiveId,
    threadId: thread.id,
    messageId: ownerMessage.id,
  });

  const [hive] = await sql<{ name: string }[]>`
    SELECT name FROM hives WHERE id = ${input.hiveId}
  `;
  const history = await getThreadMessages(sql, thread.id);
  const apiBaseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXT_PUBLIC_DASHBOARD_URL ??
    DEFAULT_API_BASE_URL;
  const prompt = await buildEaPrompt(sql, {
    hiveId: input.hiveId,
    hiveName: input.hiveName ?? hive?.name ?? "unknown",
    history,
    currentOwnerMessage: input.content,
    apiBaseUrl,
    auditContext: {
      source: "dashboard",
      sourceHiveId: input.hiveId,
      threadId: thread.id,
      ownerMessageId: ownerMessage.id,
    },
  });
  const promptWithAttachments = attachments.length > 0
    ? `${prompt}\n${attachmentSection}`
    : prompt;
  const streamController = new AbortController();
  const signal = linkAbortSignals(input.signal, streamController.signal);
  const eaStream = runEaStream(promptWithAttachments, {
    signal,
    attachmentPaths: attachments.map((attachment) => attachment.absolutePath),
  });

  const stream = (async function* () {
    let accumulated = "";
    let completed = false;
    try {
      for await (const chunk of eaStream) {
        accumulated += chunk;
        yield chunk;
      }
      completed = true;
    } finally {
      if (!completed) {
        streamController.abort();
      }
      const assistantMessage = await appendMessage(
        sql,
        thread.id,
        "assistant",
        accumulated,
        null,
        "dashboard",
      );
      await emitEaChatEvent(sql, {
        type: "ea_message_created",
        hiveId: input.hiveId,
        threadId: thread.id,
        messageId: assistantMessage.id,
      });
      scheduleImplicitQualityExtraction(sql, {
        hiveId: input.hiveId,
        ownerMessage: input.content,
        ownerMessageId: ownerMessage.id,
      });
    }
  })();

  return { thread, ownerMessage, stream };
}

function linkAbortSignals(
  external: AbortSignal | undefined,
  internal: AbortSignal,
): AbortSignal {
  if (!external) return internal;
  return AbortSignal.any([external, internal]);
}

export const dashboardEaClient: DashboardEaClient = {
  async submit(text, ctx) {
    const turn = await prepareDashboardTurn(appSql, {
      hiveId: ctx.hiveId,
      hiveName: ctx.hiveName,
      content: text,
      attachments: ctx.attachments,
      signal: ctx.signal,
    });
    return turn.stream;
  },
};

export async function getDashboardChat(
  sql: Sql,
  input: {
    hiveId: string;
    userId: string;
    limit?: number;
    before?: string | null;
  },
): Promise<DashboardChatState> {
  const thread = await getOrCreateActiveThread(
    sql,
    input.hiveId,
    dashboardChannelId(input.hiveId),
  );
  const limit = Math.min(Math.max(input.limit ?? 40, 1), 80);
  const rows = await sql<DashboardChatMessage[]>`
    SELECT id, thread_id as "threadId", role, content,
           discord_message_id as "discordMessageId",
           source,
           voice_session_id as "voiceSessionId",
           status,
           error,
           created_at as "createdAt",
           updated_at as "updatedAt"
    FROM ea_messages
    WHERE thread_id = ${thread.id}
      AND (${input.before ?? null}::timestamp IS NULL OR created_at < ${input.before ?? null}::timestamp)
    ORDER BY created_at DESC
    LIMIT ${limit + 1}
  `;

  return {
    thread,
    messages: rows.slice(0, limit).reverse(),
    hasMore: rows.length > limit,
  };
}

export const getDashboardEaThreadWithMessages = getDashboardChat;

export async function startFreshDashboardThread(
  sql: Sql,
  input: { hiveId: string; userId: string },
): Promise<EaThread> {
  const channelId = dashboardChannelId(input.hiveId);
  await closeActiveThread(sql, input.hiveId, channelId);
  return getOrCreateActiveThread(sql, input.hiveId, channelId);
}

export async function sendDashboardMessage(
  sql: Sql,
  input: {
    hiveId: string;
    hiveName?: string;
    userId: string;
    content: string;
    attachments?: EaAttachment[];
    signal?: AbortSignal;
  },
): Promise<DashboardSendResult> {
  const turn = await prepareDashboardTurn(sql, {
    hiveId: input.hiveId,
    hiveName: input.hiveName,
    content: input.content,
    attachments: input.attachments,
    signal: input.signal,
  });

  for await (const chunk of turn.stream) {
    void chunk;
    // Drain the stream for the JSON-compatible API path. The streaming
    // API path consumes the same adapter directly and sends each chunk.
  }

  const [latestAssistant] = await sql<EaMessage[]>`
    SELECT id, thread_id as "threadId", role, content,
           discord_message_id as "discordMessageId",
           source,
           voice_session_id as "voiceSessionId",
           status,
           error,
           created_at as "createdAt",
           updated_at as "updatedAt"
    FROM ea_messages
    WHERE thread_id = ${turn.thread.id}
      AND role = 'assistant'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const assistantMessage = latestAssistant;
  if (!assistantMessage) {
    throw new Error("Dashboard EA completed without persisting an assistant message");
  }

  return {
    thread: turn.thread,
    threadId: turn.thread.id,
    ownerMessage: turn.ownerMessage,
    assistantMessage,
  };
}

export const sendDashboardEaMessage = sendDashboardMessage;
