import { describe, it, expect, beforeEach } from "vitest";
import { POST as subscribe } from "@/app/api/push/subscribe/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const PREFIX = "t12-pwa-";
let hiveId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES (${PREFIX + "biz"}, 'T12 PWA Test', 'digital')
    RETURNING id
  `;
  hiveId = biz.id;
});

describe("Push Subscribe API", () => {
  it("POST /api/push/subscribe — stores a push subscription (201)", async () => {
    const req = new Request("http://localhost/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        subscription: {
          endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint-1",
          keys: {
            p256dh: "BNcRdreALRFXTkOOUHK1ABCD1234567890",
            auth: "tBHItJI5svbpC7htgKQ==",
          },
        },
      }),
    });

    const res = await subscribe(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeDefined();
    expect(body.data.hiveId).toBe(hiveId);
    expect(body.data.endpoint).toBe(
      "https://fcm.googleapis.com/fcm/send/test-endpoint-1",
    );
  });

  it("POST /api/push/subscribe — returns 400 without subscription data", async () => {
    const req = new Request("http://localhost/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId }),
    });

    const res = await subscribe(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("POST /api/push/subscribe — returns 400 without hiveId", async () => {
    const req = new Request("http://localhost/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subscription: {
          endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint-2",
          keys: {
            p256dh: "BNcRdreALRFXTkOOUHK1ABCD1234567890",
            auth: "tBHItJI5svbpC7htgKQ==",
          },
        },
      }),
    });

    const res = await subscribe(req);
    expect(res.status).toBe(400);
  });

  it("POST /api/push/subscribe — upserts on same endpoint", async () => {
    // First insert
    const req1 = new Request("http://localhost/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        subscription: {
          endpoint: "https://fcm.googleapis.com/fcm/send/test-upsert",
          keys: {
            p256dh: "original-p256dh-key",
            auth: "original-auth",
          },
        },
      }),
    });
    const res1 = await subscribe(req1);
    expect(res1.status).toBe(201);
    const body1 = await res1.json();

    // Upsert with new keys
    const req2 = new Request("http://localhost/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        subscription: {
          endpoint: "https://fcm.googleapis.com/fcm/send/test-upsert",
          keys: {
            p256dh: "updated-p256dh-key",
            auth: "updated-auth",
          },
        },
      }),
    });
    const res2 = await subscribe(req2);
    expect(res2.status).toBe(201);
    const body2 = await res2.json();

    // Should return the same record (same endpoint), with updated keys
    expect(body2.data.endpoint).toBe(body1.data.endpoint);
    expect(body2.data.p256dh).toBe("updated-p256dh-key");
    expect(body2.data.auth).toBe("updated-auth");

    // Verify only one row exists for that endpoint
    const rows = await sql`
      SELECT * FROM push_subscriptions
      WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/test-upsert'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].p256dh).toBe("updated-p256dh-key");
  });
});
