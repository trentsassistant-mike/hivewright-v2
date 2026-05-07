import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { resolveHiveWorkspaceRoot } from "@/hives/workspace-root";

export interface AttachmentWriteResult {
  filename: string;
  storagePath: string;
  mimeType: string | null;
  sizeBytes: number;
}

export function prepareAttachmentWrite(
  hiveSlug: string,
  parentId: string,
  file: File,
): AttachmentWriteResult {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");

  // Strip path components; replace unsafe chars to prevent path traversal
  const safeName = path.basename(file.name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const storedName = `${randomUUID()}-${safeName}`;

  const dir = path.join(
    resolveHiveWorkspaceRoot(),
    hiveSlug,
    "task-attachments",
    parentId,
    yyyy,
    mm,
    dd,
  );
  const storagePath = path.join(dir, storedName);

  return {
    filename: file.name,
    storagePath,
    mimeType: file.type || null,
    sizeBytes: file.size,
  };
}

export async function writePreparedAttachment(
  attachment: AttachmentWriteResult,
  file: File,
): Promise<void> {
  fs.mkdirSync(path.dirname(attachment.storagePath), { recursive: true });

  const bytes = await file.arrayBuffer();
  fs.writeFileSync(attachment.storagePath, Buffer.from(bytes));
}

export function removeAttachmentFile(storagePath: string): void {
  fs.rmSync(storagePath, { force: true });
}

export async function writeAttachment(
  hiveSlug: string,
  parentId: string,
  file: File,
): Promise<AttachmentWriteResult> {
  const attachment = prepareAttachmentWrite(hiveSlug, parentId, file);
  await writePreparedAttachment(attachment, file);
  return attachment;
}
