import { describe, it, expect, beforeEach } from "vitest";
import { GET as getPreferences, POST as createPreference } from "@/app/api/notifications/preferences/route";
import { DELETE as deletePreference } from "@/app/api/notifications/preferences/[id]/route";
import { POST as testNotification } from "@/app/api/notifications/test/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const PREFIX = "t10-notif-";
let hiveId: string;
let prefId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES (${PREFIX + "biz"}, 'T10 Notification Pref Test', 'digital')
    RETURNING id
  `;
  hiveId = biz.id;

  // Seed one preference so tests that need prefId can use it
  const [pref] = await sql`
    INSERT INTO notification_preferences (hive_id, channel, config, priority_filter, enabled)
    VALUES (${hiveId}, 'discord', '{"webhook_url":"https://example.com/hook"}', 'urgent', true)
    RETURNING id
  `;
  prefId = pref.id;
});

describe("Notification Preferences API", () => {
  it("POST /api/notifications/preferences — creates preference (201)", async () => {
    const req = new Request(
      "http://localhost/api/notifications/preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hiveId,
          channel: "email",
          config: { address: "test@example.com" },
          priorityFilter: "normal",
          enabled: true,
        }),
      },
    );

    const res = await createPreference(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeDefined();
    expect(body.data.hiveId).toBe(hiveId);
    expect(body.data.channel).toBe("email");
    expect(body.data.config).toEqual({ address: "test@example.com" });
    expect(body.data.priorityFilter).toBe("normal");
    expect(body.data.enabled).toBe(true);
  });

  it("POST /api/notifications/preferences — returns 400 for missing channel", async () => {
    const req = new Request(
      "http://localhost/api/notifications/preferences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId }),
      },
    );

    const res = await createPreference(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/hiveId.*channel|channel.*hiveId|required/i);
  });

  it("GET /api/notifications/preferences — lists preferences for hive", async () => {
    const req = new Request(
      `http://localhost/api/notifications/preferences?hiveId=${hiveId}`,
    );

    const res = await getPreferences(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const found = body.data.find((p: { id: string }) => p.id === prefId);
    expect(found).toBeDefined();
    expect(found.channel).toBe("discord");
  });

  it("GET /api/notifications/preferences — returns 400 without hiveId", async () => {
    const req = new Request(
      "http://localhost/api/notifications/preferences",
    );

    const res = await getPreferences(req);
    expect(res.status).toBe(400);
  });

  it("DELETE /api/notifications/preferences/[id] — removes preference", async () => {
    const req = new Request(
      `http://localhost/api/notifications/preferences/${prefId}`,
      { method: "DELETE" },
    );

    const res = await deletePreference(req, {
      params: Promise.resolve({ id: prefId }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.deleted).toBe(true);

    // Verify it's gone
    const rows = await sql`SELECT id FROM notification_preferences WHERE id = ${prefId}`;
    expect(rows.length).toBe(0);
  });

  it("DELETE /api/notifications/preferences/[id] — returns 404 for nonexistent", async () => {
    const req = new Request(
      "http://localhost/api/notifications/preferences/00000000-0000-0000-0000-000000000000",
      { method: "DELETE" },
    );

    const res = await deletePreference(req, {
      params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("Notification Test Route", () => {
  it("POST /api/notifications/test — sends a test notification", async () => {
    // Create an email preference so there's something to send to
    await sql`
      INSERT INTO notification_preferences (hive_id, channel, config, priority_filter, enabled)
      VALUES (${hiveId}, 'email', '{}', 'all', true)
    `;

    const req = new Request(
      "http://localhost/api/notifications/test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveId }),
      },
    );

    const res = await testNotification(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.sent).toBeGreaterThanOrEqual(1);
  });

  it("POST /api/notifications/test — returns 400 without hiveId", async () => {
    const req = new Request(
      "http://localhost/api/notifications/test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );

    const res = await testNotification(req);
    expect(res.status).toBe(400);
  });
});
