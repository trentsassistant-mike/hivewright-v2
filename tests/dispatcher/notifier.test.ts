import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storeCredential } from "@/credentials/manager";
import {
  getNotifierConfig,
  isDiscordSnowflake,
  OutboundNotifier,
  type NotifierSender,
} from "@/dispatcher/notifier";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DECISION_CHANNEL = "1487611062928019600";
const ACHIEVED_CHANNEL = "1487611062928019618";
const FAILED_CHANNEL = "1487611062953050204";
const TEST_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

beforeEach(async () => {
  await truncateAll(sql);
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}::uuid, 'notifier-hive', 'Notifier Hive', 'digital')
  `;
  await installEaDiscord();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ENCRYPTION_KEY;
});

describe("outbound notifier", () => {
  it("validates the owner-provided Discord channel ids as snowflakes", () => {
    expect(isDiscordSnowflake(ACHIEVED_CHANNEL)).toBe(true);
    expect(isDiscordSnowflake(FAILED_CHANNEL)).toBe(true);
    expect(getNotifierConfig({}).achievedChannelId).toBe(ACHIEVED_CHANNEL);
    expect(getNotifierConfig({}).failedChannelId).toBe(FAILED_CHANNEL);
  });

  it("routes each allowed category to the configured channel", async () => {
    await insertPendingDecision("decision-1");
    await insertGoal("goal-achieved", "achieved");
    await insertGoal("goal-failed", "failed");
    await insertGoal("goal-abandoned", "abandoned");

    const sent: { channelId: string; content: string }[] = [];
    const notifier = new OutboundNotifier(sql, testConfig(), captureSender(sent));

    await notifier.scanAndQueue();
    await notifier.flushAll();

    expect(sent.map((msg) => msg.channelId).sort()).toEqual([
      ACHIEVED_CHANNEL,
      DECISION_CHANNEL,
      FAILED_CHANNEL,
    ].sort());
    expect(sent.find((msg) => msg.channelId === DECISION_CHANNEL)?.content).toContain("Decision needs you");
    expect(sent.find((msg) => msg.channelId === ACHIEVED_CHANNEL)?.content).toContain("Goal achieved");
    expect(sent.find((msg) => msg.channelId === FAILED_CHANNEL)?.content).toContain("2 HiveWright updates");
  });

  it("coalesces three rapid events in one bucket into one message", async () => {
    await insertGoal("goal-failed-1", "failed");
    await insertGoal("goal-failed-2", "failed");
    await insertGoal("goal-failed-3", "abandoned");

    const sent: { channelId: string; content: string }[] = [];
    const notifier = new OutboundNotifier(sql, testConfig(), captureSender(sent));

    await notifier.scanAndQueue();
    expect(sent).toHaveLength(0);

    await notifier.flushAll();
    expect(sent).toHaveLength(1);
    expect(sent[0].channelId).toBe(FAILED_CHANNEL);
    expect(sent[0].content).toContain("3 HiveWright updates");
  });

  it("does not resend a replayed source event id", async () => {
    await insertPendingDecision("decision-replay");

    const sent: { channelId: string; content: string }[] = [];
    const notifier = new OutboundNotifier(sql, testConfig(), captureSender(sent));

    await notifier.scanAndQueue();
    await notifier.flushAll();
    await notifier.scanAndQueue();
    await notifier.flushAll();

    expect(sent).toHaveLength(1);
    const rows = await sql`
      SELECT status, notified_at FROM outbound_notifications
      WHERE source_id = ${"00000000-0000-4000-8000-000000000101"}::uuid
    `;
    expect(rows[0].status).toBe("sent");
    expect(rows[0].notified_at).toBeTruthy();
  });

  it("does not notify the owner for supervisor EA-review decisions until EA escalates them", async () => {
    await insertSupervisorEaReviewDecision();

    const sent: { channelId: string; content: string }[] = [];
    const notifier = new OutboundNotifier(sql, testConfig(), captureSender(sent));

    await notifier.scanAndQueue();
    await notifier.flushAll();

    expect(sent).toHaveLength(0);
    const before = await sql`
      SELECT id FROM outbound_notifications
      WHERE source_id = ${"00000000-0000-4000-8000-000000000301"}::uuid
    `;
    expect(before).toHaveLength(0);

    await sql`
      UPDATE decisions
      SET status = 'pending', ea_decided_at = NOW()
      WHERE id = ${"00000000-0000-4000-8000-000000000301"}::uuid
    `;

    await notifier.scanAndQueue();
    await notifier.flushAll();

    expect(sent).toHaveLength(1);
    expect(sent[0].channelId).toBe(DECISION_CHANNEL);
    expect(sent[0].content).toContain("Decision needs you");
  });

  it("dry-run mode records the payload without hitting Discord", async () => {
    await insertGoal("goal-dry-run", "achieved");
    const sender = vi.fn<NotifierSender>(async () => ({ ok: true }));
    const notifier = new OutboundNotifier(sql, { ...testConfig(), dryRun: true }, sender);

    await notifier.scanAndQueue();
    await notifier.flushAll();

    expect(sender).not.toHaveBeenCalled();
    const [row] = await sql<{ status: string; payload: { channelId: string; content: string } }[]>`
      SELECT status, payload FROM outbound_notifications
      WHERE source_id = ${"00000000-0000-4000-8000-000000000201"}::uuid
    `;
    expect(row.status).toBe("dry_run");
    expect(row.payload.channelId).toBe(ACHIEVED_CHANNEL);
    expect(row.payload.content).toContain("Goal achieved");
  });

  it("retries one failed send once, then drops the audit row without throwing", async () => {
    await insertGoal("goal-send-failure", "achieved");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sender = vi.fn<NotifierSender>(async () => ({ ok: false, error: "discord unavailable" }));
    const notifier = new OutboundNotifier(sql, testConfig(), sender);

    await notifier.scanAndQueue();
    await notifier.flushAll();

    expect(sender).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropping outbound Discord notification after retry"));
    const [row] = await sql<{ status: string; notified_at: Date | null; payload: { error?: string } }[]>`
      SELECT status, notified_at, payload FROM outbound_notifications
      WHERE source_id = ${"00000000-0000-4000-8000-000000000202"}::uuid
    `;
    expect(row.status).toBe("dropped");
    expect(row.notified_at).toBeTruthy();
    expect(row.payload.error).toBe("discord unavailable");
  });
});

function testConfig() {
  return {
    throttleMs: 60_000,
    dryRun: false,
    achievedChannelId: ACHIEVED_CHANNEL,
    failedChannelId: FAILED_CHANNEL,
    lookbackHours: 24,
  };
}

function captureSender(sent: { channelId: string; content: string }[]): NotifierSender {
  return async (message) => {
    sent.push({ channelId: message.channelId, content: message.content });
    return { ok: true };
  };
}

async function installEaDiscord() {
  const cred = await storeCredential(sql, {
    hiveId: HIVE_ID,
    name: "EA Discord",
    key: "connector:ea-discord:notifier-test",
    value: JSON.stringify({ botToken: "test-token" }),
    encryptionKey: TEST_ENCRYPTION_KEY,
  });
  await sql`
    INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, credential_id)
    VALUES (
      ${HIVE_ID}::uuid,
      'ea-discord',
      'EA Discord',
      ${sql.json({ channelId: DECISION_CHANNEL, applicationId: "1487611062928019601" })},
      ${cred.id}::uuid
    )
  `;
}

async function insertPendingDecision(label: string) {
  const id = label === "decision-replay"
    ? "00000000-0000-4000-8000-000000000101"
    : "00000000-0000-4000-8000-000000000001";
  await sql`
    INSERT INTO decisions (id, hive_id, title, context, recommendation, status, priority)
    VALUES (
      ${id}::uuid,
      ${HIVE_ID}::uuid,
      ${label},
      'Owner judgement is required.',
      'Pick the business-safe option.',
      'pending',
      'normal'
    )
  `;
}

async function insertSupervisorEaReviewDecision() {
  await sql`
    INSERT INTO decisions (
      id, hive_id, title, context, recommendation, status, priority, kind
    )
    VALUES (
      ${"00000000-0000-4000-8000-000000000301"}::uuid,
      ${HIVE_ID}::uuid,
      'supervisor finding needs EA triage',
      'Hive Supervisor found a recurring failure.',
      'EA should resolve autonomously or escalate.',
      'ea_review',
      'normal',
      'supervisor_flagged'
    )
  `;
}

async function insertGoal(label: string, status: "achieved" | "failed" | "abandoned") {
  const ids: Record<string, string> = {
    "goal-achieved": "00000000-0000-4000-8000-000000000011",
    "goal-failed": "00000000-0000-4000-8000-000000000012",
    "goal-abandoned": "00000000-0000-4000-8000-000000000013",
    "goal-failed-1": "00000000-0000-4000-8000-000000000021",
    "goal-failed-2": "00000000-0000-4000-8000-000000000022",
    "goal-failed-3": "00000000-0000-4000-8000-000000000023",
    "goal-dry-run": "00000000-0000-4000-8000-000000000201",
    "goal-send-failure": "00000000-0000-4000-8000-000000000202",
  };
  await sql`
    INSERT INTO goals (id, hive_id, title, description, status, updated_at)
    VALUES (
      ${ids[label]}::uuid,
      ${HIVE_ID}::uuid,
      ${label},
      'The goal status changed.',
      ${status},
      NOW()
    )
  `;
}
