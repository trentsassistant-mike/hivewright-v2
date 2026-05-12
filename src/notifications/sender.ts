import { createHash } from "node:crypto";
import type { Sql } from "postgres";

export interface NotificationPayload {
  hiveId: string;
  title: string;
  message: string;
  priority: "urgent" | "normal" | "low";
  source?: string; // e.g. "dispatcher", "doctor", "decision"
  idempotencyKey?: string;
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

function notificationIdempotencyKey(payload: NotificationPayload, installId: string): string {
  if (payload.idempotencyKey) return `notification:${payload.idempotencyKey}:${installId}`;
  const digest = createHash("sha256")
    .update(JSON.stringify({
      hiveId: payload.hiveId,
      installId,
      source: payload.source ?? "notifications",
      title: payload.title,
      message: payload.message,
      priority: payload.priority,
    }))
    .digest("hex")
    .slice(0, 40);
  return `notification:${digest}`;
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
    const { requestExternalAction } = await import("../actions/external-actions");
    for (const install of connectorInstalls) {
      try {
        const action = await requestExternalAction(sql, {
          hiveId: payload.hiveId,
          installId: install.id,
          operation: "send_message",
          args: {
            content:
              payload.priority === "urgent"
                ? `🚨 **${payload.title}**\n\n${payload.message}`
                : `**${payload.title}**\n\n${payload.message}`,
          },
          actor: payload.source ?? "notifications",
          idempotencyKey: notificationIdempotencyKey(payload, install.id),
        });
        if (action.status === "succeeded") result.sent++;
        else if (action.status === "awaiting_approval") result.skipped++;
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
        case "telegram":
          throw new Error(
            `${pref.channel} notification_preferences are disabled; install a governed connector instead`,
          );
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
