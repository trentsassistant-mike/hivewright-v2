import { sql } from "../../../_lib/db";
import { jsonOk, jsonError } from "../../../_lib/responses";
import { requireApiAuth } from "../../../_lib/auth";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  try {
    const { id } = await params;

    const rows = await sql`
      DELETE FROM notification_preferences
      WHERE id = ${id}
      RETURNING id
    `;

    if (rows.length === 0) {
      return jsonError("Notification preference not found", 404);
    }

    return jsonOk({ deleted: true });
  } catch {
    return jsonError("Failed to delete notification preference", 500);
  }
}
