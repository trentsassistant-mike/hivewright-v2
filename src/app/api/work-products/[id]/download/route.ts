import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { sql } from "../../../_lib/db";
import { requireApiUser } from "../../../_lib/auth";
import { canAccessHive } from "@/auth/users";
import { assertPathInHiveWorkspace, assertRealPathInHiveWorkspace } from "@/work-products/image-storage";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;

    const { id } = await params;
    const rows = await sql`
      SELECT
        wp.file_path,
        wp.mime_type,
        wp.artifact_kind,
        wp.hive_id,
        h.workspace_path
      FROM work_products wp
      JOIN hives h ON h.id = wp.hive_id
      WHERE wp.id = ${id}
      LIMIT 1
    `;
    if (rows.length === 0) return new Response("Not found", { status: 404 });

    const row = rows[0] as {
      file_path: string | null;
      mime_type: string | null;
      artifact_kind: string | null;
      hive_id: string;
      workspace_path: string | null;
    };
    if (
      row.artifact_kind !== "image" ||
      !row.file_path ||
      !row.workspace_path ||
      (row.mime_type !== "image/png" && row.mime_type !== "image/jpeg")
    ) {
      return new Response("Not found", { status: 404 });
    }

    if (!authz.user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, authz.user.id, row.hive_id);
      if (!hasAccess) return new Response("Forbidden", { status: 403 });
    }

    let resolved: string;
    try {
      resolved = assertPathInHiveWorkspace(row.file_path, row.workspace_path);
      resolved = await assertRealPathInHiveWorkspace(resolved, row.workspace_path);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    if (!existsSync(resolved)) return new Response("Not found", { status: 404 });

    const bytes = await fs.readFile(resolved);
    const filename = path.basename(resolved).replace(/[\r\n]/g, "_").replace(/"/g, '\\"');
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": row.mime_type ?? "application/octet-stream",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Content-Length": String(bytes.length),
      },
    });
  } catch {
    return new Response("Internal server error", { status: 500 });
  }
}
