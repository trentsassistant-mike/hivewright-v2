import { NextResponse } from "next/server";
import { sql } from "../../../../_lib/db";
import { jsonOk, jsonError } from "../../../../_lib/responses";
import { requireApiUser } from "../../../../_lib/auth";
import { canAccessHive } from "@/auth/users";
import { validateAttachmentFiles } from "@/attachments/constants";
import { persistAttachmentsForParent } from "@/attachments/persist";
import { isValidStatus } from "../_status";
import { ideaRowToApi } from "../idea-row";
import {
  isSystemPath,
  readSystemRoleHeader,
  sessionPathFrom,
} from "../_created-by";

const ALLOWED = new Set([
  "title",
  "body",
  "status",
  "archived",
  "ai_assessment",
  "promoted_to_goal_id",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formValue(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" ? value : null;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; ideaId: string }> },
) {
  const { id, ideaId } = await params;

  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  if (!user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, user.id, id);
    if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
  }

  // The human owner's dashboard session is privileged (isSystemOwner=true)
  // but is NOT on the system path — ai_assessment is populated by the
  // Sprint 3 daily-review agent, not by the owner. The agent identifies
  // itself via `X-System-Role: ideas-curator` (same trusted seam used by the
  // POST handler). Owner-facing edits (title/body/status/archived) are
  // always allowed for privileged sessions regardless of the header.
  const headerRole = readSystemRoleHeader(request);
  if (headerRole === "INVALID") {
    return jsonError(
      "invalid X-System-Role header (must be a lowercase role slug, 1-50 chars)",
      400,
    );
  }
  const sessionPath = sessionPathFrom(user, headerRole);

  const [existing] = await sql`
    SELECT id FROM hive_ideas WHERE id = ${ideaId} AND hive_id = ${id}
  `;
  if (!existing) return jsonError("idea not found", 404);

  let body: Record<string, unknown>;
  let files: File[] = [];
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      files = formData.getAll("files").filter((value): value is File => value instanceof File);
      const validationError = validateAttachmentFiles(files);
      if (validationError) return jsonError(validationError, 400);
      body = {};
      const title = formValue(formData, "title");
      const ideaBody = formValue(formData, "body");
      if (title !== null) body.title = title;
      if (ideaBody !== null) body.body = ideaBody;
    } else {
      body = await request.json();
    }
  } catch {
    return jsonError("invalid request body", 400);
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED.has(key)) return jsonError(`unknown field: ${key}`, 400);
  }

  if ("ai_assessment" in body && !isSystemPath(sessionPath)) {
    return jsonError(
      "ai_assessment is system-only (X-System-Role required)",
      403,
    );
  }

  const updates: Record<string, unknown> = {};

  if ("title" in body) {
    if (typeof body.title !== "string" || body.title.trim() === "") {
      return jsonError("title cannot be empty", 400);
    }
    updates.title = body.title.trim();
  }

  if ("body" in body) {
    updates.body = body.body === null || body.body === "" ? null : String(body.body);
  }

  if ("archived" in body) {
    if (body.archived !== true) {
      return jsonError("archived must be true (use status to un-archive)", 400);
    }
    if ("status" in body && body.status !== "archived") {
      return jsonError("archived=true conflicts with status field", 400);
    }
    updates.status = "archived";
  }

  if ("status" in body) {
    if (!isValidStatus(body.status)) {
      return jsonError(
        "invalid status (must be open | reviewed | promoted | archived)",
        400,
      );
    }
    updates.status = body.status;
  }

  if ("ai_assessment" in body) {
    updates.ai_assessment = body.ai_assessment === null ? null : String(body.ai_assessment);
  }

  if ("promoted_to_goal_id" in body) {
    const val = body.promoted_to_goal_id;
    if (val === null) {
      updates.promoted_to_goal_id = null;
    } else if (typeof val === "string" && UUID_RE.test(val)) {
      updates.promoted_to_goal_id = val;
    } else {
      return jsonError("promoted_to_goal_id must be a uuid or null", 400);
    }
  }

  try {
    const row = await sql.begin(async (tx) => {
      if (Object.keys(updates).length > 0) {
        await tx`
          UPDATE hive_ideas
          SET ${tx(updates)}, updated_at = NOW()
          WHERE id = ${ideaId}
        `;
      }

      await persistAttachmentsForParent(tx, id, ideaId, files, { ideaId });

      const [updatedRow] = await tx`SELECT * FROM hive_ideas WHERE id = ${ideaId}`;
      return updatedRow;
    });

    return jsonOk(ideaRowToApi(row as Record<string, unknown>));
  } catch {
    return jsonError("failed to update idea", 500);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; ideaId: string }> },
) {
  const { id, ideaId } = await params;

  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  if (!user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, user.id, id);
    if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
  }

  const result = await sql`
    DELETE FROM hive_ideas WHERE id = ${ideaId} AND hive_id = ${id}
  `;
  if (result.count === 0) return jsonError("idea not found", 404);

  return new NextResponse(null, { status: 204 });
}
