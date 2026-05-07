import { NextResponse } from "next/server";
import { sql } from "../../../../_lib/db";
import { jsonOk, jsonError } from "../../../../_lib/responses";
import { requireApiUser } from "../../../../_lib/auth";
import { canAccessHive } from "@/auth/users";
import { isValidStatus } from "../_status";

const ALLOWED = new Set(["title", "target_value", "deadline", "notes", "sort_order", "status"]);

function rowToApi(row: Record<string, unknown>) {
  return {
    id: row.id,
    hiveId: row.hive_id,
    title: row.title,
    targetValue: row.target_value,
    deadline: row.deadline,
    notes: row.notes,
    sortOrder: row.sort_order,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; targetId: string }> },
) {
  const { id, targetId } = await params;

  // Audit d20f7b46 Sprint 2: hive-scoped mutation must require hive access.
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  if (!user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, user.id, id);
    if (!hasAccess) {
      return jsonError("Forbidden: caller cannot access this hive", 403);
    }
  }

  const [existing] = await sql`
    SELECT id FROM hive_targets WHERE id = ${targetId} AND hive_id = ${id}
  `;
  if (!existing) return jsonError("target not found", 404);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED.has(key)) return jsonError(`unknown field: ${key}`, 400);
  }

  const updates: Record<string, unknown> = {};
  if ("title" in body) {
    if (typeof body.title !== "string" || body.title.trim() === "") {
      return jsonError("title cannot be empty", 400);
    }
    updates.title = body.title.trim();
  }
  if ("target_value" in body) {
    updates.target_value = body.target_value === null ? null : String(body.target_value);
  }
  if ("deadline" in body) {
    const raw = body.deadline;
    updates.deadline = raw === null || raw === "" ? null : String(raw);
  }
  if ("notes" in body) {
    updates.notes = body.notes === null ? null : String(body.notes);
  }
  if ("sort_order" in body) {
    if (typeof body.sort_order !== "number") {
      return jsonError("sort_order must be a number", 400);
    }
    updates.sort_order = body.sort_order;
  }
  if ("status" in body) {
    if (!isValidStatus(body.status)) {
      return jsonError("invalid status (must be open | achieved | abandoned)", 400);
    }
    updates.status = body.status;
  }

  if (Object.keys(updates).length > 0) {
    await sql`
      UPDATE hive_targets
      SET ${sql(updates)}, updated_at = NOW()
      WHERE id = ${targetId}
    `;
  }

  const [row] = await sql`SELECT * FROM hive_targets WHERE id = ${targetId}`;
  return jsonOk(rowToApi(row));
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; targetId: string }> },
) {
  const { id, targetId } = await params;

  // Audit d20f7b46 Sprint 2: hive-scoped mutation must require hive access.
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  if (!user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, user.id, id);
    if (!hasAccess) {
      return jsonError("Forbidden: caller cannot access this hive", 403);
    }
  }

  const result = await sql`
    DELETE FROM hive_targets WHERE id = ${targetId} AND hive_id = ${id}
  `;
  if (result.count === 0) return jsonError("target not found", 404);

  return new NextResponse(null, { status: 204 });
}
