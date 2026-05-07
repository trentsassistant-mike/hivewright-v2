import { sql } from "../../_lib/db";
import { jsonOk, jsonError } from "../../_lib/responses";
import { requireApiAuth } from "../../_lib/auth";

type SubscriptionRow = {
  id: string;
  hive_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: Date;
};

function mapRow(r: SubscriptionRow) {
  return {
    id: r.id,
    hiveId: r.hive_id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    createdAt: r.created_at,
  };
}

export async function POST(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  try {
    const body = await request.json();
    const { hiveId, subscription } = body;

    if (!hiveId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return jsonError("hiveId and subscription (with endpoint, keys.p256dh, keys.auth) are required", 400);
    }

    const { endpoint, keys } = subscription;
    const { p256dh, auth } = keys;

    const rows = await sql`
      INSERT INTO push_subscriptions (hive_id, endpoint, p256dh, auth)
      VALUES (${hiveId}, ${endpoint}, ${p256dh}, ${auth})
      ON CONFLICT (endpoint) DO UPDATE
        SET p256dh = EXCLUDED.p256dh,
            auth = EXCLUDED.auth,
            hive_id = EXCLUDED.hive_id
      RETURNING *
    `;

    return jsonOk(mapRow(rows[0] as unknown as SubscriptionRow), 201);
  } catch {
    return jsonError("Failed to store push subscription", 500);
  }
}
