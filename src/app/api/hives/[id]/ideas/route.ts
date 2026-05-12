import { sql } from "../../../_lib/db";
import { jsonOk, jsonError } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { canAccessHive } from "@/auth/users";
import { validateAttachmentFiles } from "@/attachments/constants";
import { persistAttachmentsForParent } from "@/attachments/persist";
import { isValidStatus } from "./_status";
import {
  readSystemRoleHeader,
  resolveCreatedBy,
  sessionPathFrom,
} from "./_created-by";
import { ideaRowToApi } from "./idea-row";

interface IdeaInput {
  title?: unknown;
  body?: unknown;
}

function formValue(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  return typeof value === "string" ? value : null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  if (!user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, user.id, id);
    if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
  }

  const statusParam = new URL(request.url).searchParams.get("status");
  const status = statusParam ?? "open";
  if (!isValidStatus(status)) {
    return jsonError(
      "invalid status (must be open | reviewed | promoted | archived)",
      400,
    );
  }

  const rows = await sql`
    SELECT * FROM hive_ideas
    WHERE hive_id = ${id} AND status = ${status}
    ORDER BY created_at DESC
  `;
  return jsonOk(rows.map(ideaRowToApi));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  if (!user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, user.id, id);
    if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
  }

  // `created_by` is derived from the authenticated session path — never from
  // the request body. The trusted signal is the `X-System-Role` header, which
  // is only honored when paired with a privileged (system-owner) session:
  //   - privileged + no header   → "owner"          (dashboard)
  //   - privileged + header="ea" → "ea"             (native EA, Sprint 2)
  //   - privileged + header=<r>  → <r>              (agent, e.g. Sprint 3)
  //   - non-privileged           → "system"         (hive member)
  // Malformed header values are rejected rather than silently falling back,
  // so a typo in an agent caller surfaces immediately. See _created-by.ts.
  const headerRole = readSystemRoleHeader(request);
  if (headerRole === "INVALID") {
    return jsonError(
      "invalid X-System-Role header (must be a lowercase role slug, 1-50 chars)",
      400,
    );
  }
  const sessionPath = sessionPathFrom(user, headerRole);

  const [hive] = await sql`SELECT id FROM hives WHERE id = ${id}`;
  if (!hive) return jsonError("hive not found", 404);

  let body: IdeaInput;
  let files: File[] = [];
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      files = formData.getAll("files").filter((value): value is File => value instanceof File);
      const validationError = validateAttachmentFiles(files);
      if (validationError) return jsonError(validationError, 400);
      body = {
        title: formValue(formData, "title"),
        body: formValue(formData, "body"),
      };
    } else {
      body = await request.json();
    }
  } catch {
    return jsonError("invalid request body", 400);
  }

  if (typeof body.title !== "string" || body.title.trim() === "") {
    return jsonError("title is required", 400);
  }
  const ideaTitle = body.title.trim();

  const ideaBody =
    typeof body.body === "string" && body.body.trim() !== ""
      ? body.body
      : null;
  const createdBy = resolveCreatedBy(sessionPath);

  try {
    const row = await sql.begin(async (tx) => {
      const [createdRow] = await tx`
        INSERT INTO hive_ideas (hive_id, title, body, created_by)
        VALUES (${id}, ${ideaTitle}, ${ideaBody}, ${createdBy})
        RETURNING *
      `;

      await persistAttachmentsForParent(tx, id, createdRow.id as string, files, {
        ideaId: createdRow.id as string,
      });

      return createdRow;
    });

    return jsonOk(ideaRowToApi(row as Record<string, unknown>), 201);
  } catch {
    return jsonError("failed to save idea", 500);
  }
}
