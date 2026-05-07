import { describe, it, expect, beforeEach } from "vitest";
import {
  sendNotification,
  priorityMatches,
  type NotificationPayload,
} from "@/notifications/sender";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('test-notif-biz', 'Notification Test Biz', 'digital')
    RETURNING id
  `;
  bizId = biz.id;
});

describe("priorityMatches", () => {
  it("'all' matches every priority", () => {
    expect(priorityMatches("all", "urgent")).toBe(true);
    expect(priorityMatches("all", "normal")).toBe(true);
    expect(priorityMatches("all", "low")).toBe(true);
  });

  it("'urgent' matches only urgent", () => {
    expect(priorityMatches("urgent", "urgent")).toBe(true);
    expect(priorityMatches("urgent", "normal")).toBe(false);
    expect(priorityMatches("urgent", "low")).toBe(false);
  });

  it("'normal' matches everything except urgent", () => {
    expect(priorityMatches("normal", "normal")).toBe(true);
    expect(priorityMatches("normal", "low")).toBe(true);
    expect(priorityMatches("normal", "urgent")).toBe(false);
  });
});

describe("notification_preferences table", () => {
  it("can insert and query preferences", async () => {
    await sql`
      INSERT INTO notification_preferences (hive_id, channel, config, priority_filter, enabled)
      VALUES (${bizId}, 'discord', ${sql.json({ webhook_url: "https://example.com/webhook" })}, 'all', true)
    `;

    const rows = await sql`
      SELECT * FROM notification_preferences WHERE hive_id = ${bizId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe("discord");
    expect(rows[0].config).toEqual({ webhook_url: "https://example.com/webhook" });
    expect(rows[0].priority_filter).toBe("all");
    expect(rows[0].enabled).toBe(true);
  });

  it("defaults enabled to true and priority_filter to 'all'", async () => {
    await sql`
      INSERT INTO notification_preferences (hive_id, channel, config)
      VALUES (${bizId}, 'email', '{}')
    `;

    const [row] = await sql`
      SELECT * FROM notification_preferences WHERE hive_id = ${bizId}
    `;
    expect(row.enabled).toBe(true);
    expect(row.priority_filter).toBe("all");
  });
});

describe("sendNotification", () => {
  const basePayload: NotificationPayload = {
    hiveId: "", // filled in tests
    title: "Test Notification",
    message: "Something happened",
    priority: "normal",
    source: "test",
  };

  it("returns zeros when no preferences configured", async () => {
    const result = await sendNotification(sql, {
      ...basePayload,
      hiveId: bizId,
    });
    expect(result).toEqual({ sent: 0, errors: 0, skipped: 0 });
  });

  it("skips disabled preferences", async () => {
    await sql`
      INSERT INTO notification_preferences (hive_id, channel, config, enabled)
      VALUES (${bizId}, 'email', '{}', false)
    `;

    const result = await sendNotification(sql, {
      ...basePayload,
      hiveId: bizId,
    });
    expect(result).toEqual({ sent: 0, errors: 0, skipped: 0 });
  });

  it("skips when priority filter does not match", async () => {
    // urgent-only pref should skip normal notifications
    await sql`
      INSERT INTO notification_preferences (hive_id, channel, config, priority_filter, enabled)
      VALUES (${bizId}, 'email', '{}', 'urgent', true)
    `;

    const result = await sendNotification(sql, {
      ...basePayload,
      hiveId: bizId,
      priority: "normal",
    });
    expect(result).toEqual({ sent: 0, errors: 0, skipped: 1 });
  });

  it("sends to email (log-only) when priority matches", async () => {
    await sql`
      INSERT INTO notification_preferences (hive_id, channel, config, priority_filter, enabled)
      VALUES (${bizId}, 'email', '{}', 'all', true)
    `;

    const result = await sendNotification(sql, {
      ...basePayload,
      hiveId: bizId,
    });
    expect(result).toEqual({ sent: 1, errors: 0, skipped: 0 });
  });

  it("sends to push (log-only) when priority matches", async () => {
    await sql`
      INSERT INTO notification_preferences (hive_id, channel, config, priority_filter, enabled)
      VALUES (${bizId}, 'push', '{}', 'all', true)
    `;

    const result = await sendNotification(sql, {
      ...basePayload,
      hiveId: bizId,
    });
    expect(result).toEqual({ sent: 1, errors: 0, skipped: 0 });
  });

  it("counts errors when discord webhook_url is missing", async () => {
    await sql`
      INSERT INTO notification_preferences (hive_id, channel, config, priority_filter, enabled)
      VALUES (${bizId}, 'discord', '{}', 'all', true)
    `;

    const result = await sendNotification(sql, {
      ...basePayload,
      hiveId: bizId,
    });
    expect(result.errors).toBe(1);
    expect(result.sent).toBe(0);
  });

  it("handles multiple preferences with mixed results", async () => {
    // email (works), discord without config (errors), urgent-only email (skipped for normal)
    await sql`
      INSERT INTO notification_preferences (hive_id, channel, config, priority_filter, enabled)
      VALUES
        (${bizId}, 'email', '{}', 'all', true),
        (${bizId}, 'discord', '{}', 'all', true),
        (${bizId}, 'email', '{}', 'urgent', true)
    `;

    const result = await sendNotification(sql, {
      ...basePayload,
      hiveId: bizId,
      priority: "normal",
    });
    expect(result.sent).toBe(1);   // email with "all" filter
    expect(result.errors).toBe(1); // discord without config
    expect(result.skipped).toBe(1); // email with "urgent" filter
  });
});
