import { sql } from "../../_lib/db";
import { jsonOk, jsonError } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import { canAccessHive } from "@/auth/users";

const ALLOWED_FIELDS = new Set(["name", "description", "mission"]);
const REJECTED_FIELDS = new Set([
  "slug", "type", "id", "createdAt", "created_at",
  "eaSessionId", "ea_session_id", "workspacePath", "workspace_path",
]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { id } = await params;
  if (!id) return jsonError("id is required", 400);
  const [row] = await sql`
    SELECT id, slug, name, type, description, mission, workspace_path, is_system_fixture, created_at
    FROM hives WHERE id = ${id}
  `;
  if (!row) return jsonError("hive not found", 404);
  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, id);
    if (!hasAccess) {
      return jsonError("Forbidden: hive access required", 403);
    }
  }
  return jsonOk({
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    description: row.description,
    mission: row.mission,
    workspacePath: row.workspace_path,
    isSystemFixture: row.is_system_fixture,
    createdAt: row.created_at,
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { id } = await params;
  if (!id) return jsonError("id is required", 400);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }

  for (const key of Object.keys(body)) {
    if (REJECTED_FIELDS.has(key)) {
      return jsonError(`field not editable: ${key}`, 400);
    }
    if (!ALLOWED_FIELDS.has(key)) {
      return jsonError(`unknown field: ${key}`, 400);
    }
  }

  if (typeof body.name === "string" && body.name.trim() === "") {
    return jsonError("name cannot be empty", 400);
  }

  const [existing] = await sql`SELECT id FROM hives WHERE id = ${id}`;
  if (!existing) return jsonError("hive not found", 404);

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, id);
    if (!hasAccess) {
      return jsonError("Forbidden: hive access required", 403);
    }
  }

  if (typeof body.name === "string") {
    await sql`UPDATE hives SET name = ${body.name} WHERE id = ${id}`;
  }
  if ("description" in body) {
    const v = body.description === null ? null : String(body.description);
    await sql`UPDATE hives SET description = ${v} WHERE id = ${id}`;
  }
  if ("mission" in body) {
    const v = body.mission === null ? null : String(body.mission);
    await sql`UPDATE hives SET mission = ${v} WHERE id = ${id}`;
  }

  const [row] = await sql`
    SELECT id, slug, name, type, description, mission, workspace_path, is_system_fixture, created_at
    FROM hives WHERE id = ${id}
  `;

  return jsonOk({
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    description: row.description,
    mission: row.mission,
    workspacePath: row.workspace_path,
    isSystemFixture: row.is_system_fixture,
    createdAt: row.created_at,
  });
}
