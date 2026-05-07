import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type { Sql } from "postgres";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Attachment,
  type Message,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  appendMessage,
  closeActiveThread,
  getOrCreateActiveThread,
  getThreadMessages,
} from "./thread-store";
import { buildEaPrompt } from "./prompt";
import { runEa } from "./runner";
import { handleIdeaCaptureMessage } from "./idea-capture";
import { scheduleImplicitQualityExtraction } from "@/quality/ea-post-turn";
import {
  EA_ATTACHMENT_ROOT,
  EA_MAX_ATTACHMENT_BYTES,
  type EaAttachment,
  renderEaAttachmentSection,
  sanitizeEaAttachmentFilename,
} from "./attachments";

/**
 * Save Discord attachments for a single owner message to a per-message
 * directory under /tmp so the EA's Codex runtime can read them by path.
 * Discord's CDN URLs are signed but unauthenticated,
 * so a plain fetch works. Returns the saved files; failures are logged
 * and skipped (a missing image must never block the reply).
 */
async function downloadAttachments(message: Message): Promise<EaAttachment[]> {
  if (message.attachments.size === 0) return [];

  const dir = path.join(EA_ATTACHMENT_ROOT, message.id);
  fs.mkdirSync(dir, { recursive: true });

  const saved: EaAttachment[] = [];
  for (const a of message.attachments.values() as IterableIterator<Attachment>) {
    if (a.size > EA_MAX_ATTACHMENT_BYTES) {
      console.warn(`[ea-native] skipping attachment ${a.name} (${a.size} bytes > cap)`);
      continue;
    }
    const safeName = sanitizeEaAttachmentFilename(a.name ?? `file-${saved.length}`);
    const dest = path.join(dir, safeName);
    try {
      const res = await fetch(a.url);
      if (!res.ok || !res.body) {
        console.warn(`[ea-native] attachment ${a.name} fetch failed: ${res.status}`);
        continue;
      }
      const stream = Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream);
      await pipeline(stream, fs.createWriteStream(dest));
      saved.push({
        filename: safeName,
        absolutePath: dest,
        contentType: a.contentType ?? null,
        size: a.size,
      });
    } catch (err) {
      console.warn(`[ea-native] attachment ${a.name} save failed:`, err);
    }
  }
  return saved;
}

/**
 * Native Discord EA connector — replaces the OpenClaw-gateway-hosted EA
 * with a direct discord.js integration running inside the dispatcher
 * process. See `docs/ops/` (TBD) for the parity matrix vs the OpenClaw
 * version; MVP handles `/status`, `/new`, and free-form DM/channel
 * chat for a single hive.
 */

export interface NativeEaConfig {
  /** Bot token for the Discord application the EA owns. */
  discordToken: string;
  /** The hive this EA speaks for. Multi-hive routing is future work. */
  hiveId: string;
  /** Channel ID the EA listens to. DMs from any user also reach this hive. */
  channelId: string;
  /** HiveWright API base URL (passed into prompts so the EA can curl it). */
  apiBaseUrl: string;
  /** Optional model for the EA runtime. When unset, the runtime uses its configured default. */
  model?: string;
  /** Working directory for shell access — usually the hivewrightv2 repo. */
  workspacePath?: string;
}

export interface NativeEaHandle {
  client: Client;
  shutdown: () => Promise<void>;
}

export async function startNativeEa(
  sql: Sql,
  config: NativeEaConfig,
): Promise<NativeEaHandle> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  // Serialise per-channel processing — two messages arriving in quick
  // succession otherwise race each other on getOrCreateActiveThread +
  // message-ordering. Simple per-channel promise chain does the job.
  const channelLocks = new Map<string, Promise<void>>();
  function onChannel(channelId: string, fn: () => Promise<void>): Promise<void> {
    const prev = channelLocks.get(channelId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    channelLocks.set(channelId, next);
    next.finally(() => {
      if (channelLocks.get(channelId) === next) channelLocks.delete(channelId);
    });
    return next;
  }

  client.once(Events.ClientReady, (c) => {
    console.log(`[ea-native] connected as ${c.user.tag} (listening on channel ${config.channelId})`);
  });

  client.on(Events.MessageCreate, (message) => {
    // Skip bot messages (including our own) to avoid echo loops.
    if (message.author.bot) return;
    // Only respond in DMs or the configured channel for this MVP.
    const isDm = !message.guildId;
    if (!isDm && message.channelId !== config.channelId) return;
    onChannel(message.channelId, () => handleMessage(sql, config, client, message));
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    onChannel(interaction.channelId ?? "dm", () => handleSlashCommand(sql, config, interaction));
  });

  await client.login(config.discordToken);

  return {
    client,
    shutdown: async () => {
      try {
        await client.destroy();
      } catch (err) {
        console.error("[ea-native] destroy error:", err);
      }
    },
  };
}

async function handleMessage(
  sql: Sql,
  config: NativeEaConfig,
  client: Client,
  message: Message,
): Promise<void> {
  try {
    const [hive] = await sql<{ name: string }[]>`
      SELECT name FROM hives WHERE id = ${config.hiveId}
    `;
    if (!hive) {
      await message.reply("Configured hive not found in the DB — EA can't start a conversation.");
      return;
    }

    // Owner shortcut: messages prefixed with "idea:", "add idea:", or
    // "park this:" are explicit captures into the ideas backlog. Skip
    // attachment download, EA reasoning, and delegation entirely — just
    // persist the row and acknowledge so capture stays pressure-free.
    const captured = await handleIdeaCaptureMessage(
      sql,
      config.hiveId,
      config.apiBaseUrl,
      message.channelId,
      message.content,
      message.id,
    );
    if (captured !== null) {
      for (const chunk of splitForDiscord(captured.reply)) {
        await message.reply(chunk);
      }
      return;
    }

    // Pull down any image / PDF / file attachments to /tmp BEFORE we
    // build the prompt so the EA agent can View them via its Read tool.
    // Native EA used to drop attachments silently — owner sent a
    // screenshot and the EA replied "I don't see an image". Fixed.
    const attachments = await downloadAttachments(message);

    const thread = await getOrCreateActiveThread(sql, config.hiveId, message.channelId);
    // Persist a copy of the message including attachment metadata so
    // the assistant can refer back to "the screenshot you sent" later
    // in the thread without us re-uploading it.
    const persistedContent = attachments.length > 0
      ? `${message.content}\n\n${renderEaAttachmentSection(attachments)}`
      : message.content;
    const ownerMessage = await appendMessage(sql, thread.id, "owner", persistedContent, message.id);

    // Show "typing" so the owner knows we're working. Discord's typing
    // indicator expires after ~10s, so we re-fire it on a heartbeat
    // below until the EA turn returns. Guard with feature detection:
    // group DM channels don't expose sendTyping.
    const channel = message.channel as unknown as { sendTyping?: () => Promise<void> };
    const safeSendTyping = async () => {
      if (typeof channel.sendTyping === "function") {
        try { await channel.sendTyping(); } catch { /* non-fatal */ }
      }
    };
    await safeSendTyping();

    // Heartbeat — keeps the typing dots alive so a long turn (curl
    // investigation, file edits, build, commit, etc.) doesn't look
    // like a hang. 8s interval stays comfortably inside Discord's
    // ~10s typing-expiry window. Owner explicitly preferred this
    // over an interim text ack ("On it…") which read as noisy chatter.
    const typingHeartbeat = setInterval(() => {
      void safeSendTyping();
    }, 8_000);

    const history = await getThreadMessages(sql, thread.id);

    const basePrompt = await buildEaPrompt(sql, {
      hiveId: config.hiveId,
      hiveName: hive.name,
      history,
      currentOwnerMessage: message.content,
      apiBaseUrl: config.apiBaseUrl,
      auditContext: {
        source: "discord",
        sourceHiveId: config.hiveId,
        threadId: thread.id,
        ownerMessageId: ownerMessage.id,
      },
    });
    const prompt = attachments.length > 0
      ? `${basePrompt}\n${renderEaAttachmentSection(attachments)}`
      : basePrompt;

    let result;
    try {
      result = await runEa(prompt, {
        model: config.model,
        cwd: config.workspacePath,
        attachmentPaths: attachments.map((attachment) => attachment.absolutePath),
      });
    } finally {
      // Always tear down the heartbeat — including on throw — so we
      // never leak intervals.
      clearInterval(typingHeartbeat);
    }

    const reply = result.success && result.text.trim().length > 0
      ? result.text.trim()
      : `(EA runtime error: ${result.error ?? "empty response"})`;

    await appendMessage(sql, thread.id, "assistant", reply);
    scheduleImplicitQualityExtraction(sql, {
      hiveId: config.hiveId,
      ownerMessage: message.content,
      ownerMessageId: ownerMessage.id,
    });

    // Discord message size cap is 2000 chars; chunk across messages if
    // the model gave us a long answer. Keep each chunk under the cap.
    for (const chunk of splitForDiscord(reply)) {
      await message.reply(chunk);
    }
  } catch (err) {
    console.error("[ea-native] handleMessage error:", err);
    try {
      await message.reply("Something went wrong on my end — check the dispatcher logs. I'm still listening.");
    } catch { /* give up quietly */ }
  }
}

async function handleSlashCommand(
  sql: Sql,
  config: NativeEaConfig,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    if (interaction.commandName === "new") {
      await closeActiveThread(sql, config.hiveId, interaction.channelId ?? "dm");
      await interaction.reply({
        content: "Fresh thread started. Prior conversation history is closed and won't be referenced in new replies.",
        ephemeral: true,
      });
      return;
    }
    if (interaction.commandName === "status") {
      await interaction.deferReply({ ephemeral: true });
      const summary = await buildStatusSummary(sql, config.hiveId);
      await interaction.editReply(summary);
      return;
    }
    await interaction.reply({ content: `Unknown command: \`/${interaction.commandName}\``, ephemeral: true });
  } catch (err) {
    console.error("[ea-native] handleSlashCommand error:", err);
    if (interaction.deferred || interaction.replied) {
      try { await interaction.editReply("Something went wrong running that command."); } catch { /* ignore */ }
    } else {
      try { await interaction.reply({ content: "Something went wrong running that command.", ephemeral: true }); } catch { /* ignore */ }
    }
  }
}

async function buildStatusSummary(sql: Sql, hiveId: string): Promise<string> {
  const [counts] = await sql<
    {
      active_goals: string;
      pending_decisions: string;
      pending_system_errors: string;
      unresolvable_tasks: string;
      recent_completions: string;
    }[]
  >`
    SELECT
      (SELECT COUNT(*) FROM goals WHERE hive_id = ${hiveId} AND status = 'active') AS active_goals,
      (SELECT COUNT(*) FROM decisions WHERE hive_id = ${hiveId} AND status = 'pending' AND kind = 'decision') AS pending_decisions,
      (SELECT COUNT(*) FROM decisions WHERE hive_id = ${hiveId} AND status = 'pending' AND kind = 'system_error') AS pending_system_errors,
      (SELECT COUNT(*) FROM tasks WHERE hive_id = ${hiveId} AND status = 'unresolvable') AS unresolvable_tasks,
      (SELECT COUNT(*) FROM goals WHERE hive_id = ${hiveId} AND status = 'achieved' AND updated_at > NOW() - INTERVAL '7 days') AS recent_completions
  `;

  const activeGoals = await sql<{ title: string }[]>`
    SELECT title FROM goals
    WHERE hive_id = ${hiveId} AND status = 'active'
    ORDER BY created_at DESC LIMIT 5
  `;

  const lines: string[] = ["**HiveWright status**"];
  lines.push(`- Active goals: ${counts.active_goals}`);
  lines.push(`- Pending decisions waiting on you: ${counts.pending_decisions}`);
  lines.push(`- System errors to triage: ${counts.pending_system_errors}`);
  lines.push(`- Unresolvable tasks: ${counts.unresolvable_tasks}`);
  lines.push(`- Goals achieved in the last 7 days: ${counts.recent_completions}`);
  if (activeGoals.length > 0) {
    lines.push("", "**What's in flight:**");
    for (const g of activeGoals) lines.push(`- ${g.title}`);
  }
  return lines.join("\n");
}

function splitForDiscord(text: string): string[] {
  const MAX = 1900; // Discord limit is 2000; leave slack for ``` fences etc.
  if (text.length <= MAX) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX) {
      chunks.push(remaining);
      break;
    }
    // Prefer cutting at a newline or space near the boundary; fall back to hard cut.
    const slice = remaining.slice(0, MAX);
    const nl = slice.lastIndexOf("\n");
    const sp = slice.lastIndexOf(" ");
    const cutAt = nl > MAX * 0.7 ? nl : sp > MAX * 0.7 ? sp : MAX;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  return chunks;
}
