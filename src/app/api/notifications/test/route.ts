import { sql } from "../../_lib/db";
import { jsonOk, jsonError } from "../../_lib/responses";
import { requireApiAuth } from "../../_lib/auth";
import { sendNotification } from "../../../../notifications/sender";

export async function POST(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  try {
    const body = await request.json();
    const { hiveId } = body as { hiveId?: string };

    if (!hiveId) {
      return jsonError("hiveId is required", 400);
    }

    const result = await sendNotification(sql, {
      hiveId,
      title: "Test Notification",
      message: "This is a test notification from HiveWright.",
      priority: "urgent",
      source: "test",
    });

    return jsonOk(result);
  } catch {
    return jsonError("Failed to send test notification", 500);
  }
}
