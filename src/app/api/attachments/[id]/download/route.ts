import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { sql } from "../../../_lib/db";
import { requireSystemOwner } from "../../../_lib/auth";
import { resolveHiveWorkspaceRoot } from "@/hives/workspace-root";

// Session presence is enforced by src/proxy.ts middleware (see
// docs/security/2026-04-22-middleware-gating-verification.md). On top of
// that, this handler adds the per-handler ownership gate: only the
// dashboard system owner (users.is_system_owner = true) may download
// attachments. The schema has no per-user owner column on task_attachments,
// tasks, or goals — tasks.created_by stores role slugs ("owner", "ea",
// "system", role templates), not user ids — so the system-owner check is
// the tightest user-level ownership rule the current schema supports, and
// mirrors the guard used on credentials and dispatcher/restart.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authz = await requireSystemOwner();
    if ("response" in authz) return authz.response;

    const { id } = await params;

    const rows = await sql`
      SELECT filename, storage_path, mime_type
      FROM task_attachments
      WHERE id = ${id}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return new Response("Not found", { status: 404 });
    }
    const { filename, storage_path, mime_type } = rows[0] as {
      filename: string;
      storage_path: string;
      mime_type: string | null;
    };

    // Defense-in-depth: only serve files under the canonical storage root.
    // Resolves any `..` segments, then checks the prefix.
    const resolved = path.resolve(storage_path);
    const storageRoot = resolveHiveWorkspaceRoot();
    if (!resolved.startsWith(storageRoot + path.sep)) {
      return new Response("Not found", { status: 404 });
    }

    if (!existsSync(resolved)) {
      return new Response("Not found", { status: 404 });
    }

    const bytes = await fs.readFile(resolved);
    // Strip CR/LF (header-injection guard) and escape internal quotes.
    const safeForHeader = filename.replace(/[\r\n]/g, "_").replace(/"/g, '\\"');

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": mime_type ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${safeForHeader}"`,
        "Content-Length": String(bytes.length),
      },
    });
  } catch {
    return new Response("Internal server error", { status: 500 });
  }
}
