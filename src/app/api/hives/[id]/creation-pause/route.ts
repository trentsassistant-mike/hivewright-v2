import { sql } from "@/app/api/_lib/db";
import { requireSystemOwner } from "@/app/api/_lib/auth";
import { jsonError, jsonOk } from "@/app/api/_lib/responses";
import { getHiveCreationPause, setHiveCreationPause } from "@/operations/creation-pause";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) return jsonError("id must be a valid UUID", 400);

  const [hive] = await sql`SELECT 1 FROM hives WHERE id = ${id} LIMIT 1`;
  if (!hive) return jsonError("hive not found", 404);

  return jsonOk(await getHiveCreationPause(sql, id));
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  if (!UUID_RE.test(id)) return jsonError("id must be a valid UUID", 400);

  let body: { paused?: unknown; reason?: unknown };
  try {
    body = await request.json() as { paused?: unknown; reason?: unknown };
  } catch {
    return jsonError("invalid JSON", 400);
  }

  if (typeof body.paused !== "boolean") {
    return jsonError("paused must be a boolean", 400);
  }

  const paused = body.paused;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (paused && reason.length === 0) {
    return jsonError("reason is required when pausing creation", 400);
  }
  if (reason.length > 500) return jsonError("reason is too long", 400);

  const [hive] = await sql`SELECT 1 FROM hives WHERE id = ${id} LIMIT 1`;
  if (!hive) return jsonError("hive not found", 404);

  return jsonOk(await setHiveCreationPause(sql, {
    hiveId: id,
    paused,
    reason,
    changedBy: authz.user.email,
  }));
}
