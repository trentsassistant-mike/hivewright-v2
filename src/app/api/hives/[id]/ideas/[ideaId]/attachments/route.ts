import { sql } from "../../../../../_lib/db";
import { jsonOk, jsonError } from "../../../../../_lib/responses";
import { requireApiUser } from "../../../../../_lib/auth";
import { canAccessHive } from "@/auth/users";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; ideaId: string }> },
) {
  try {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;

    const { id, ideaId } = await params;
    if (!authz.user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, authz.user.id, id);
      if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
    }

    const ideaCheck = await sql`
      SELECT id FROM hive_ideas WHERE id = ${ideaId} AND hive_id = ${id}
    `;
    if (ideaCheck.length === 0) {
      return jsonError("Idea not found", 404);
    }

    const rows = await sql`
      SELECT id, filename, mime_type, size_bytes, uploaded_at
      FROM task_attachments
      WHERE idea_id = ${ideaId}
      ORDER BY uploaded_at ASC
    `;

    return jsonOk(
      rows.map((row) => ({
        id: row.id,
        filename: row.filename,
        mimeType: row.mime_type,
        sizeBytes: Number(row.size_bytes),
        uploadedAt: row.uploaded_at,
        source: "idea",
      })),
    );
  } catch {
    return jsonError("Failed to fetch attachments", 500);
  }
}
