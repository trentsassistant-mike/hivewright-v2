import fs from "node:fs";
import type { Sql } from "postgres";
import { decrypt } from "../../credentials/encryption";

export type NotifierCategory = "decision_owner" | "goal_achieved" | "goal_failed";

export interface OutboundNotificationEvent {
  id: string;
  hiveId: string | null;
  category: NotifierCategory;
  sourceTable: string;
  sourceId: string;
  channelId: string;
  title: string;
  reason: string;
}

export interface NotifierConfig {
  throttleMs: number;
  dryRun: boolean;
  decisionChannelId?: string;
  achievedChannelId: string;
  failedChannelId: string;
  lookbackHours: number;
}

export interface OutboundNotifierConfig extends NotifierConfig {
  pollMs?: number;
  dryRunLogPath?: string;
}

export interface NotifierSendResult {
  ok: boolean;
  error?: string;
}

export type NotifierSender = (event: {
  hiveId: string | null;
  channelId: string;
  content: string;
}) => Promise<NotifierSendResult>;

export type LegacyNotificationCategory = "owner_decision" | "goal_achieved" | "goal_failed";

export interface LegacyOutboundNotificationEvent {
  id?: string | number;
  category: LegacyNotificationCategory;
  entityType: "decision" | "goal";
  entityId: string;
  hiveId: string | null;
  channelId: string;
  title: string;
  context: string;
  createdAt?: Date;
}

export interface OutboundNotificationSender {
  send(input: { channelId: string; content: string; hiveId: string | null }): Promise<void>;
}

interface Bucket {
  events: OutboundNotificationEvent[];
  timer: NodeJS.Timeout | null;
}

const DEFAULT_ACHIEVED_CHANNEL_ID = "1487611062928019618";
const DEFAULT_FAILED_CHANNEL_ID = "1487611062953050204";
const SNOWFLAKE_RE = /^\d{17,20}$/;

export function isDiscordSnowflake(value: string): boolean {
  return SNOWFLAKE_RE.test(value);
}

export function getNotifierConfig(env: Partial<NodeJS.ProcessEnv> = process.env): NotifierConfig {
  const achievedChannelId =
    env.EA_NOTIFIER_GOAL_ACHIEVED_CHANNEL_ID ??
    env.NOTIFIER_GOAL_ACHIEVED_CHANNEL_ID ??
    DEFAULT_ACHIEVED_CHANNEL_ID;
  const failedChannelId =
    env.EA_NOTIFIER_GOAL_FAILED_CHANNEL_ID ??
    env.NOTIFIER_GOAL_FAILED_CHANNEL_ID ??
    DEFAULT_FAILED_CHANNEL_ID;
  if (!isDiscordSnowflake(achievedChannelId)) {
    throw new Error(`NOTIFIER_GOAL_ACHIEVED_CHANNEL_ID is not a valid Discord snowflake: ${achievedChannelId}`);
  }
  if (!isDiscordSnowflake(failedChannelId)) {
    throw new Error(`NOTIFIER_GOAL_FAILED_CHANNEL_ID is not a valid Discord snowflake: ${failedChannelId}`);
  }

  const decisionChannelId = env.EA_NOTIFIER_DECISION_CHANNEL_ID ?? env.NOTIFIER_DECISION_CHANNEL_ID;
  if (decisionChannelId && !isDiscordSnowflake(decisionChannelId)) {
    throw new Error(`NOTIFIER_DECISION_CHANNEL_ID is not a valid Discord snowflake: ${decisionChannelId}`);
  }

  return {
    throttleMs: Number(env.EA_NOTIFIER_THROTTLE_MS ?? env.NOTIFIER_THROTTLE_MS ?? 60_000),
    dryRun:
      env.EA_NOTIFIER_DRY_RUN === "1" ||
      env.EA_NOTIFIER_DRY_RUN === "true" ||
      env.NOTIFIER_DRY_RUN === "1" ||
      env.NOTIFIER_DRY_RUN === "true",
    decisionChannelId,
    achievedChannelId,
    failedChannelId,
    lookbackHours: Number(env.EA_NOTIFIER_LOOKBACK_HOURS ?? env.NOTIFIER_LOOKBACK_HOURS ?? 24),
  };
}

export const getOutboundNotifierConfig = getNotifierConfig;

export function buildNotificationMessage(events: OutboundNotificationEvent[]): string {
  if (events.length === 1) {
    const event = events[0];
    return [
      event.title,
      `Entity: ${event.sourceTable} ${event.sourceId}`,
      `Reason: ${oneLine(event.reason)}`,
    ].join("\n");
  }

  const lines = [`${events.length} HiveWright updates`];
  for (const event of events) {
    lines.push(`- ${event.title} (${event.sourceTable} ${event.sourceId}): ${oneLine(event.reason)}`);
  }
  return lines.join("\n").slice(0, 1900);
}

export function buildOutboundNotificationMessage(events: LegacyOutboundNotificationEvent[]): string {
  return buildNotificationMessage(events.map((event) => ({
    id: String(event.id ?? event.entityId),
    hiveId: event.hiveId,
    category: event.category === "owner_decision" ? "decision_owner" : event.category,
    sourceTable: event.entityType === "decision" ? "decisions" : "goals",
    sourceId: event.entityId,
    channelId: event.channelId,
    title: event.title,
    reason: event.context,
  })));
}

export class ThrottledNotificationBuckets {
  private readonly buckets = new Map<string, LegacyOutboundNotificationEvent[]>();
  private readonly lastDeliveredAt = new Map<string, number>();

  constructor(
    private readonly throttleMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  enqueue(event: LegacyOutboundNotificationEvent): void {
    const key = `${event.category}:${event.channelId}`;
    const bucket = this.buckets.get(key) ?? [];
    bucket.push(event);
    this.buckets.set(key, bucket);
  }

  readyBatches(): LegacyOutboundNotificationEvent[][] {
    const ready: LegacyOutboundNotificationEvent[][] = [];
    for (const [key, events] of this.buckets) {
      const last = this.lastDeliveredAt.get(key);
      if (last !== undefined && this.now() - last < this.throttleMs) continue;
      ready.push([...events]);
      this.buckets.delete(key);
      this.lastDeliveredAt.set(key, this.now());
    }
    return ready;
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

export class OutboundNotifier {
  private readonly buckets = new Map<string, Bucket>();
  private readonly queuedIds = new Set<string>();
  private readonly sender: NotifierSender;

  constructor(
    private readonly sql: Sql,
    private readonly config: NotifierConfig = getNotifierConfig(),
    sender?: NotifierSender,
  ) {
    this.sender = sender ?? ((message) => sendDiscordChannelMessage(this.sql, message));
  }

  async scanAndQueue(): Promise<number> {
    const created = await this.recordEligibleEvents();
    const pending = await this.loadUnsentEvents();
    for (const event of pending) {
      this.queue(event);
    }
    return created + pending.length;
  }

  queue(event: OutboundNotificationEvent): void {
    if (this.queuedIds.has(event.id)) return;
    this.queuedIds.add(event.id);

    const key = `${event.category}:${event.channelId}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { events: [], timer: null };
      this.buckets.set(key, bucket);
    }
    bucket.events.push(event);

    if (!bucket.timer) {
      bucket.timer = setTimeout(() => {
        void this.flushBucket(key);
      }, this.config.throttleMs);
    }
  }

  async flushAll(): Promise<void> {
    const keys = [...this.buckets.keys()];
    await Promise.all(keys.map((key) => this.flushBucket(key)));
  }

  stop(): void {
    for (const bucket of this.buckets.values()) {
      if (bucket.timer) clearTimeout(bucket.timer);
    }
    this.buckets.clear();
    this.queuedIds.clear();
  }

  private async recordEligibleEvents(): Promise<number> {
    const achievedChannelId = this.config.achievedChannelId;
    const failedChannelId = this.config.failedChannelId;
    const lookbackHours = this.config.lookbackHours;
    let inserted = 0;

    const decisions = await this.sql<{
      id: string;
      hive_id: string;
      title: string;
      context: string;
      recommendation: string | null;
      channel_id: string | null;
    }[]>`
      SELECT d.id, d.hive_id, d.title, d.context, d.recommendation,
             COALESCE(${this.config.decisionChannelId ?? null}, ci.config->>'channelId') AS channel_id
      FROM decisions d
      LEFT JOIN LATERAL (
        SELECT config
        FROM connector_installs
        WHERE hive_id = d.hive_id
          AND connector_slug = 'ea-discord'
          AND status = 'active'
        ORDER BY created_at DESC
        LIMIT 1
      ) ci ON true
      WHERE d.status = 'pending'
        AND COALESCE(d.ea_decided_at, d.created_at) > NOW() - (${lookbackHours} * INTERVAL '1 hour')
    `;

    for (const decision of decisions) {
      if (!decision.channel_id || !isDiscordSnowflake(decision.channel_id)) continue;
      inserted += await this.insertNotification({
        hiveId: decision.hive_id,
        category: "decision_owner",
        sourceTable: "decisions",
        sourceId: decision.id,
        channelId: decision.channel_id,
        title: `Decision needs you: ${decision.title}`,
        reason: decision.recommendation ?? decision.context,
      });
    }

    const goals = await this.sql<{
      id: string;
      hive_id: string;
      title: string;
      description: string | null;
      status: string;
    }[]>`
      SELECT id, hive_id, title, description, status
      FROM goals
      WHERE status IN ('achieved', 'failed', 'abandoned')
        AND updated_at > NOW() - (${lookbackHours} * INTERVAL '1 hour')
    `;

    for (const goal of goals) {
      const isAchieved = goal.status === "achieved";
      inserted += await this.insertNotification({
        hiveId: goal.hive_id,
        category: isAchieved ? "goal_achieved" : "goal_failed",
        sourceTable: "goals",
        sourceId: goal.id,
        channelId: isAchieved ? achievedChannelId : failedChannelId,
        title: isAchieved ? `Goal achieved: ${goal.title}` : `Goal needs attention: ${goal.title}`,
        reason: goal.description ?? `Goal status changed to ${goal.status}.`,
      });
    }

    return inserted;
  }

  private async insertNotification(event: Omit<OutboundNotificationEvent, "id">): Promise<number> {
    const rows = await this.sql`
      INSERT INTO outbound_notifications (
        hive_id, category, source_table, source_id, entity_type, entity_id, channel_id, title, reason, payload
      )
      VALUES (
        ${event.hiveId}::uuid,
        ${event.category},
        ${event.sourceTable},
        ${event.sourceId}::uuid,
        ${event.sourceTable === "decisions" ? "decision" : "goal"},
        ${event.sourceId}::uuid,
        ${event.channelId},
        ${event.title},
        ${event.reason},
        ${this.sql.json({ category: event.category })}
      )
      ON CONFLICT (category, source_table, source_id) DO NOTHING
      RETURNING id
    `;
    return rows.length;
  }

  private async loadUnsentEvents(): Promise<OutboundNotificationEvent[]> {
    const rows = await this.sql<{
      id: string;
      hive_id: string | null;
      category: NotifierCategory;
      source_table: string;
      source_id: string;
      channel_id: string;
      title: string;
      reason: string;
    }[]>`
      SELECT id, hive_id, category, source_table, source_id, channel_id, title, reason
      FROM outbound_notifications
      WHERE status IN ('pending', 'queued')
      ORDER BY created_at ASC
      LIMIT 100
    `;

    if (rows.length > 0) {
      await this.sql`
        UPDATE outbound_notifications
        SET status = 'queued', updated_at = NOW()
        WHERE id IN ${this.sql(rows.map((row) => row.id))}
      `;
    }

    return rows.map((row) => ({
      id: row.id,
      hiveId: row.hive_id,
      category: row.category,
      sourceTable: row.source_table,
      sourceId: row.source_id,
      channelId: row.channel_id,
      title: row.title,
      reason: row.reason,
    }));
  }

  private async flushBucket(key: string): Promise<void> {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    if (bucket.timer) clearTimeout(bucket.timer);
    this.buckets.delete(key);

    const events = bucket.events;
    for (const event of events) this.queuedIds.delete(event.id);
    if (events.length === 0) return;

    const content = buildNotificationMessage(events);
    const ids = events.map((event) => event.id);

    if (this.config.dryRun) {
      await this.sql`
        UPDATE outbound_notifications
        SET status = 'dry_run',
            notified_at = NOW(),
            updated_at = NOW(),
            payload = ${this.sql.json({ content, channelId: events[0].channelId })}
        WHERE id IN ${this.sql(ids)}
      `;
      return;
    }

    const result = await this.sendWithRetry({
      hiveId: events[0].hiveId,
      channelId: events[0].channelId,
      content,
    });

    if (result.ok) {
      await this.sql`
        UPDATE outbound_notifications
        SET status = 'sent',
            notified_at = NOW(),
            updated_at = NOW(),
            payload = ${this.sql.json({ content, channelId: events[0].channelId })}
        WHERE id IN ${this.sql(ids)}
      `;
      return;
    }

    console.warn(`[notifier] dropping outbound Discord notification after retry: ${result.error}`);
    await this.sql`
      UPDATE outbound_notifications
      SET status = 'dropped',
          notified_at = NOW(),
          updated_at = NOW(),
          payload = ${this.sql.json({ content, channelId: events[0].channelId, error: result.error })}
      WHERE id IN ${this.sql(ids)}
    `;
  }

  private async sendWithRetry(message: {
    hiveId: string | null;
    channelId: string;
    content: string;
  }): Promise<NotifierSendResult> {
    const first = await this.sender(message);
    if (first.ok) return first;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return this.sender(message);
  }
}

export interface OutboundNotifierHandle {
  runOnce(): Promise<number>;
  flush(): Promise<void>;
  shutdown(): void;
}

export async function discoverOutboundNotificationEvents(
  sql: Sql,
  config: Pick<OutboundNotifierConfig, "achievedChannelId" | "failedChannelId" | "decisionChannelId">,
): Promise<LegacyOutboundNotificationEvent[]> {
  const decisions = await sql<{
    id: string;
    hive_id: string;
    title: string;
    context: string;
    recommendation: string | null;
    channel_id: string | null;
    created_at: Date;
  }[]>`
    SELECT d.id, d.hive_id, d.title, d.context, d.recommendation, d.created_at,
           COALESCE(${config.decisionChannelId ?? null}, ci.config->>'channelId') AS channel_id
    FROM decisions d
    LEFT JOIN LATERAL (
      SELECT config
      FROM connector_installs
      WHERE hive_id = d.hive_id
        AND connector_slug = 'ea-discord'
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    ) ci ON true
    WHERE d.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM outbound_notifications n
        WHERE n.category = 'owner_decision'
          AND n.entity_type = 'decision'
          AND n.entity_id = d.id
      )
  `;

  const goals = await sql<{
    id: string;
    hive_id: string;
    title: string;
    description: string | null;
    status: string;
    created_at: Date;
  }[]>`
    SELECT id, hive_id, title, description, status, created_at
    FROM goals g
    WHERE status IN ('achieved', 'failed', 'abandoned')
      AND NOT EXISTS (
        SELECT 1 FROM outbound_notifications n
        WHERE n.category = CASE WHEN g.status = 'achieved' THEN 'goal_achieved' ELSE 'goal_failed' END
          AND n.entity_type = 'goal'
          AND n.entity_id = g.id
      )
  `;

  return [
    ...decisions
      .filter((decision) => decision.channel_id && isDiscordSnowflake(decision.channel_id))
      .map((decision) => ({
        category: "owner_decision" as const,
        entityType: "decision" as const,
        entityId: decision.id,
        hiveId: decision.hive_id,
        channelId: decision.channel_id!,
        title: `Decision needs you: ${decision.title}`,
        context: decision.recommendation ?? decision.context,
        createdAt: decision.created_at,
      })),
    ...goals.map((goal) => ({
      category: goal.status === "achieved" ? "goal_achieved" as const : "goal_failed" as const,
      entityType: "goal" as const,
      entityId: goal.id,
      hiveId: goal.hive_id,
      channelId: goal.status === "achieved" ? config.achievedChannelId : config.failedChannelId,
      title: goal.status === "achieved" ? `Goal achieved: ${goal.title}` : `Goal needs attention: ${goal.title}`,
      context: goal.description ?? `Goal status changed to ${goal.status}.`,
      createdAt: goal.created_at,
    })),
  ];
}

export async function enqueueOutboundNotification(
  sql: Sql,
  event: LegacyOutboundNotificationEvent,
): Promise<{ id: string } | null> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO outbound_notifications (
      hive_id, category, source_table, source_id, entity_type, entity_id, channel_id, title, reason, status, payload
    )
    VALUES (
      ${event.hiveId}::uuid,
      ${event.category},
      ${event.entityType === "decision" ? "decisions" : "goals"},
      ${event.entityId}::uuid,
      ${event.entityType},
      ${event.entityId}::uuid,
      ${event.channelId},
      ${event.title},
      ${event.context},
      'queued',
      ${sql.json({ category: event.category })}
    )
    ON CONFLICT (category, source_table, source_id) DO NOTHING
    RETURNING id
  `;
  return row ?? null;
}

export function createOutboundNotifier(
  sql: Sql,
  config: OutboundNotifierConfig,
  sender?: OutboundNotificationSender,
): OutboundNotifierHandle {
  const buckets = new ThrottledNotificationBuckets(config.throttleMs);
  let stopped = false;

  async function runOnce(): Promise<number> {
    const events = await discoverOutboundNotificationEvents(sql, config);
    let queued = 0;
    for (const event of events) {
      const row = await enqueueOutboundNotification(sql, event);
      if (row) {
        buckets.enqueue({ ...event, id: row.id });
        queued += 1;
      }
    }
    await flush();
    return queued;
  }

  async function flush(): Promise<void> {
    const batches = buckets.readyBatches();
    for (const batch of batches) {
      const content = buildOutboundNotificationMessage(batch);
      const ids = batch.map((event) => String(event.id));
      const payload = { channelId: batch[0].channelId, content, dryRun: config.dryRun };
      if (sender) {
        await sender.send({ channelId: batch[0].channelId, content, hiveId: batch[0].hiveId });
      } else if (config.dryRun && config.dryRunLogPath) {
        fs.appendFileSync(config.dryRunLogPath, `${JSON.stringify(payload)}\n`);
      } else if (!config.dryRun) {
        const result = await sendDiscordChannelMessage(sql, {
          channelId: batch[0].channelId,
          content,
          hiveId: batch[0].hiveId,
        });
        if (!result.ok) throw new Error(result.error ?? "Discord send failed");
      }
      await sql`
        UPDATE outbound_notifications
        SET status = 'sent',
            notified_at = NOW(),
            updated_at = NOW(),
            payload = ${sql.json(payload)}
        WHERE id IN ${sql(ids)}
      `;
    }
  }

  const timer = setInterval(() => {
    if (!stopped) {
      void runOnce().catch((err) => console.error("[notifier] legacy run failed:", err));
    }
  }, config.pollMs ?? 10_000);
  void runOnce().catch((err) => console.error("[notifier] legacy initial run failed:", err));

  return {
    runOnce,
    flush,
    shutdown() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function startOutboundNotifier(sql: Sql): OutboundNotifierHandle | null {
  try {
    const notifier = new OutboundNotifier(sql, getNotifierConfig());
    const pollMs = Number(process.env.EA_NOTIFIER_POLL_MS ?? process.env.NOTIFIER_POLL_MS ?? 10_000);
    const timer = setInterval(() => {
      void notifier.scanAndQueue().catch((err) => {
        console.error("[notifier] scan failed:", err);
      });
    }, pollMs);

    void notifier.scanAndQueue().catch((err) => {
      console.error("[notifier] initial scan failed:", err);
    });

    console.log("[notifier] outbound notifier started.");
    return {
      runOnce: () => notifier.scanAndQueue(),
      flush: () => notifier.flushAll(),
      shutdown() {
        clearInterval(timer);
        notifier.stop();
      },
    };
  } catch (err) {
    console.error("[notifier] outbound notifier failed to start:", err);
    return null;
  }
}

export async function sendDiscordChannelMessage(
  sql: Sql,
  message: { hiveId: string | null; channelId: string; content: string },
): Promise<NotifierSendResult> {
  if (!message.hiveId) return { ok: false, error: "missing hive id" };
  const install = await loadEaDiscordInstall(sql, message.hiveId);
  if (!install) return { ok: false, error: "no active ea-discord connector install" };

  const res = await fetch(`https://discord.com/api/v10/channels/${message.channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${install.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: message.content }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, error: `Discord returned ${res.status} ${res.statusText} ${detail}`.trim() };
  }
  return { ok: true };
}

async function loadEaDiscordInstall(
  sql: Sql,
  hiveId: string,
): Promise<{ channelId: string; botToken: string } | null> {
  const encryptionKey = process.env.ENCRYPTION_KEY ?? "";
  if (!encryptionKey) return null;

  const [install] = await sql<{
    config: { channelId?: string };
    credential_id: string | null;
  }[]>`
    SELECT config, credential_id
    FROM connector_installs
    WHERE connector_slug = 'ea-discord'
      AND status = 'active'
      AND hive_id = ${hiveId}::uuid
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!install?.credential_id) return null;

  const channelId = install.config?.channelId;
  if (!channelId || !isDiscordSnowflake(channelId)) return null;

  const [credential] = await sql<{ value: string }[]>`
    SELECT value FROM credentials WHERE id = ${install.credential_id}
  `;
  if (!credential) return null;

  try {
    const parsed = JSON.parse(decrypt(credential.value, encryptionKey)) as Record<string, string>;
    if (!parsed.botToken) return null;
    return { channelId, botToken: parsed.botToken };
  } catch (err) {
    console.warn(`[notifier] failed to decrypt ea-discord credential: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
