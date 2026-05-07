import { sql } from "../../../_lib/db";
import { buildHiveContextBlock } from "@/hives/context";
import { jsonOk, jsonError } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { canAccessHive } from "@/auth/users";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  const [hive] = await sql`SELECT id FROM hives WHERE id = ${id}`;
  if (!hive) return jsonError("hive not found", 404);
  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, id);
    if (!hasAccess) return jsonError("Forbidden: hive access required", 403);
  }
  const block = await buildHiveContextBlock(sql, id);
  return jsonOk({ block });
}
