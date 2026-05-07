import { sql } from "../../../_lib/db";
import { jsonOk, jsonError } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { canAccessHive } from "@/auth/users";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;
    const { user } = authz;
    const { id } = await params;

    const [goal] = await sql<{ id: string; hive_id: string }[]>`
      SELECT id, hive_id FROM goals WHERE id = ${id}
    `;
    if (!goal) {
      return jsonError("Goal not found", 404);
    }
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, goal.hive_id);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this goal", 403);
      }
    }

    const rows = await sql`
      SELECT id, filename, mime_type, size_bytes, uploaded_at
      FROM task_attachments
      WHERE goal_id = ${id}
      ORDER BY uploaded_at ASC
    `;
    return jsonOk(
      rows.map((r) => ({
        id: r.id,
        filename: r.filename,
        mimeType: r.mime_type,
        // safe: file size is capped at 25 MB, well within Number.MAX_SAFE_INTEGER
        sizeBytes: Number(r.size_bytes),
        uploadedAt: r.uploaded_at,
      })),
    );
  } catch {
    return jsonError("Failed to fetch attachments", 500);
  }
}
