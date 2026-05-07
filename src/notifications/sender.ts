import type { Sql } from "postgres";

export interface NotificationPayload {
  hiveId: string;
  title: string;
  message: string;
  priority: "urgent" | "normal" | "low";
  source?: string; // e.g. "dispatcher", "doctor", "decision"
}

export interface SendResult {
  sent: number;
  errors: number;
  skipped: number;
}

interface NotificationPref {
  id: string;
  channel: string;
  config: Record<string, string>;
  priority_filter: string;
  enabled: boolean;
}

/**
 * Returns true if a preference's filter matches the given notification priority.
 * - "all" matches everything
 * - "urgent" matches only "urgent"
 * - "normal" matches everything except "urgent"
 */
export function priorityMatches(filter: string, priority: string): boolean {
  if (filter === "all") return true;
  if (filter === "urgent") return priority === "urgent";
  if (filter === "normal") return priority !== "urgent";
  return true;
}

const PRIORITY_COLORS: Record<string, number> = {
  urgent: 0xff0000,  // red
  normal: 0x3498db,  // blue
  low: 0x95a5a6,     // grey
};

async function sendDiscord(
  config: Record<string, string>,
  payload: NotificationPayload,
): Promise<void> {
  const webhookUrl = config.webhook_url;
  if (!webhookUrl) throw new Error("Discord webhook_url not configured");

  const color = PRIORITY_COLORS[payload.priority] ?? 0x3498db;

  const body = {
    embeds: [
      {
        title: payload.title,
        description: payload.message,
        color,
        footer: {
          text: payload.source
            ? `HiveWright | ${payload.source}`
            : "HiveWright",
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Discord webhook failed: ${res.status} ${res.statusText}`);
  }
}

async function sendTelegram(
  config: Record<string, string>,
  payload: NotificationPayload,
): Promise<void> {
  const token = config.bot_token;
  const chatId = config.chat_id;
  if (!token || !chatId) throw new Error("Telegram bot_token or chat_id not configured");

  const priorityEmoji =
    payload.priority === "urgent" ? "\u{1F6A8}" : payload.priority === "normal" ? "\u{1F4CB}" : "\u{2139}\u{FE0F}";

  const text = `${priorityEmoji} *${payload.title}*\n\n${payload.message}${payload.source ? `\n\n_Source: ${payload.source}_` : ""}`;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    }),
  });

  if (!res.ok) {
    throw new Error(`Telegram API failed: ${res.status} ${res.statusText}`);
  }
}

function sendEmail(
  _config: Record<string, string>,
  payload: NotificationPayload,
): void {
  console.log(
    `[notification:email] ${payload.priority} — ${payload.title}: ${payload.message}`,
  );
}

function sendPush(
  _config: Record<string, string>,
  payload: NotificationPayload,
): void {
  console.log(
    `[notification:push] ${payload.priority} — ${payload.title}: ${payload.message}`,
  );
}

/**
 * Send a notification to all enabled channels for a hive.
 * Queries notification_preferences, filters by priority, dispatches per-channel.
 * Never throws on individual channel failure — catches and counts errors.
 */
export async function sendNotification(
  sql: Sql,
  payload: NotificationPayload,
): Promise<SendResult> {
  const result: SendResult = { sent: 0, errors: 0, skipped: 0 };

  // Route A: connector installs (the new path — connector_installs table).
  // Any active discord-webhook / slack / etc. connector for this hive
  // automatically receives owner notifications. This means installing a
  // connector on /setup/connectors is all the owner has to do; no
  // separate notification_preferences row needed.
  const connectorInstalls = await sql<
    { id: string; connector_slug: string }[]
  >`
    SELECT id, connector_slug
    FROM connector_installs
    WHERE hive_id = ${payload.hiveId}::uuid
      AND status = 'active'
      AND connector_slug IN ('discord-webhook')
  `;
  if (connectorInstalls.length > 0) {
    const { invokeConnector } = await import("../connectors/runtime");
    for (const install of connectorInstalls) {
      try {
        const res = await invokeConnector(sql, {
          installId: install.id,
          operation: "send_message",
          args: {
            content:
              payload.priority === "urgent"
                ? `🚨 **${payload.title}**\n\n${payload.message}`
                : `**${payload.title}**\n\n${payload.message}`,
          },
          actor: payload.source ?? "notifications",
        });
        if (res.success) result.sent++;
        else result.errors++;
      } catch {
        result.errors++;
      }
    }
  }

  // Route B: legacy notification_preferences table. Preserved so the old
  // path (Discord webhook URL stored inline, Telegram bot config) keeps
  // working until it's migrated onto the connector framework fully.
  const prefs = await sql<NotificationPref[]>`
    SELECT id, channel, config, priority_filter, enabled
    FROM notification_preferences
    WHERE hive_id = ${payload.hiveId}
      AND enabled = true
  `;

  for (const pref of prefs) {
    if (!priorityMatches(pref.priority_filter, payload.priority)) {
      result.skipped++;
      continue;
    }

    try {
      switch (pref.channel) {
        case "discord":
          await sendDiscord(pref.config, payload);
          result.sent++;
          break;
        case "telegram":
          await sendTelegram(pref.config, payload);
          result.sent++;
          break;
        case "email":
          sendEmail(pref.config, payload);
          result.sent++;
          break;
        case "push":
          sendPush(pref.config, payload);
          result.sent++;
          break;
        default:
          console.warn(`[notification] Unknown channel: ${pref.channel}`);
          result.skipped++;
      }
    } catch (err) {
      console.error(
        `[notification] Failed to send via ${pref.channel}:`,
        err instanceof Error ? err.message : err,
      );
      result.errors++;
    }
  }

  return result;
}

/**
 * Stub for PWA push-notification delivery. No-op today; Plan 7+ will wire web-push/Expo.
 * Call-sites pass `sql` for future auditing against a `push_subscriptions` table.
 */
export async function sendPushNotification(_sql: Sql, payload: NotificationPayload): Promise<void> {
  console.log(`[push-stub] ${payload.priority} ${payload.source ?? "system"}: ${payload.title}`);
}
