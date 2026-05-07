import type { Sql } from "postgres";
import {
  asEaReplayMessageLimit,
  DEFAULT_EA_REPLAY_MESSAGE_LIMIT,
  EA_REPLAY_ADAPTER_TYPE,
  EA_REPLAY_MESSAGE_LIMIT_KEY,
} from "@/ea/replay-settings";

/**
 * DB-backed EA conversation store. One active thread per (hive, channel);
 * /new closes the active thread and opens a fresh one so the next message
 * starts with no prior history. Load-history reads in timestamp order
 * so the runner can replay the conversation into the LLM.
 */

export interface EaThread {
  id: string;
  hiveId: string;
  channelId: string;
  status: string;
  createdAt: Date;
}

export interface EaMessage {
  id: string;
  threadId: string;
  role: "owner" | "assistant" | "system";
  content: string;
  discordMessageId: string | null;
  source: string;
  voiceSessionId: string | null;
  status: "queued" | "streaming" | "sent" | "failed";
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function getOrCreateActiveThread(
  sql: Sql,
  hiveId: string,
  channelId: string,
): Promise<EaThread> {
  const [existing] = await sql<EaThread[]>`
    SELECT id, hive_id as "hiveId", channel_id as "channelId", status, created_at as "createdAt"
    FROM ea_threads
    WHERE hive_id = ${hiveId} AND channel_id = ${channelId} AND status = 'active'
  `;
  if (existing) return existing;

  const [created] = await sql<EaThread[]>`
    INSERT INTO ea_threads (hive_id, channel_id, status)
    VALUES (${hiveId}, ${channelId}, 'active')
    RETURNING id, hive_id as "hiveId", channel_id as "channelId", status, created_at as "createdAt"
  `;
  return created;
}

export async function closeActiveThread(
  sql: Sql,
  hiveId: string,
  channelId: string,
): Promise<void> {
  await sql`
    UPDATE ea_threads
    SET status = 'closed', closed_at = NOW()
    WHERE hive_id = ${hiveId} AND channel_id = ${channelId} AND status = 'active'
  `;
}

export async function appendMessage(
  sql: Sql,
  threadId: string,
  role: EaMessage["role"],
  content: string,
  discordMessageId: string | null = null,
  source: string = "discord",
  voiceSessionId: string | null = null,
  status: EaMessage["status"] = "sent",
  error: string | null = null,
): Promise<EaMessage> {
  const [msg] = await sql<EaMessage[]>`
    INSERT INTO ea_messages (
      thread_id,
      role,
      content,
      discord_message_id,
      source,
      voice_session_id,
      status,
      error
    )
    VALUES (
      ${threadId},
      ${role},
      ${content},
      ${discordMessageId},
      ${source},
      ${voiceSessionId},
      ${status},
      ${error}
    )
    RETURNING id, thread_id as "threadId", role, content,
              discord_message_id as "discordMessageId",
              source,
              voice_session_id as "voiceSessionId",
              status,
              error,
              created_at as "createdAt",
              updated_at as "updatedAt"
  `;
  return msg;
}

export async function updateMessageStatus(
  sql: Sql,
  messageId: string,
  input: {
    content?: string;
    status: EaMessage["status"];
    error?: string | null;
  },
): Promise<EaMessage> {
  const [msg] = await sql<EaMessage[]>`
    UPDATE ea_messages
    SET content = COALESCE(${input.content ?? null}, content),
        status = ${input.status},
        error = ${input.error ?? null},
        updated_at = NOW()
    WHERE id = ${messageId}
    RETURNING id, thread_id as "threadId", role, content,
              discord_message_id as "discordMessageId",
              source,
              voice_session_id as "voiceSessionId",
              status,
              error,
              created_at as "createdAt",
              updated_at as "updatedAt"
  `;
  return msg;
}

export async function getThreadMessages(
  sql: Sql,
  threadId: string,
  limit?: number,
): Promise<EaMessage[]> {
  const replayLimit =
    limit === undefined ? await loadThreadReplayMessageLimit(sql) : asEaReplayMessageLimit(limit);

  // Select newest-first with LIMIT, then reverse in JS — keeps the window
  // anchored to the most recent turns when conversations get long without
  // needing an offset or OFFSET-based pagination.
  const rows = await sql<EaMessage[]>`
    SELECT id, thread_id as "threadId", role, content,
           discord_message_id as "discordMessageId",
           source,
           voice_session_id as "voiceSessionId",
           status,
           error,
           created_at as "createdAt",
           updated_at as "updatedAt"
    FROM ea_messages
    WHERE thread_id = ${threadId}
    ORDER BY created_at DESC
    LIMIT ${replayLimit}
  `;
  return rows.reverse();
}

export async function loadThreadReplayMessageLimit(sql: Sql): Promise<number> {
  const rows = await sql<{ config: Record<string, unknown> }[]>`
    SELECT config FROM adapter_config
    WHERE adapter_type = ${EA_REPLAY_ADAPTER_TYPE} AND hive_id IS NULL
    LIMIT 1
  `;

  return asEaReplayMessageLimit(
    rows[0]?.config?.[EA_REPLAY_MESSAGE_LIMIT_KEY],
    DEFAULT_EA_REPLAY_MESSAGE_LIMIT,
  );
}
