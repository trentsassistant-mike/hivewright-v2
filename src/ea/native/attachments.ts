import fs from "fs";
import path from "path";

export const EA_ATTACHMENT_ROOT = "/tmp/hivewright-ea-attachments";
/** Hard cap per attachment so a malicious upload can't fill the dispatcher's disk. */
export const EA_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface EaAttachment {
  filename: string;
  absolutePath: string;
  contentType: string | null;
  size: number;
}

export function sanitizeEaAttachmentFilename(filename: string | null | undefined): string {
  const safeName = (filename?.trim() || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
  return safeName.slice(0, 160) || "file";
}

export async function stageDashboardEaAttachments(
  scopeId: string,
  files: File[],
): Promise<EaAttachment[]> {
  if (files.length === 0) return [];

  const dir = path.join(EA_ATTACHMENT_ROOT, scopeId);
  fs.mkdirSync(dir, { recursive: true });

  const staged: EaAttachment[] = [];
  for (const file of files) {
    if (file.size > EA_MAX_ATTACHMENT_BYTES) {
      throw new Error(`File "${file.name}" exceeds the 25 MB size limit.`);
    }
    const filename = sanitizeEaAttachmentFilename(file.name || `file-${staged.length}`);
    const dest = path.join(dir, filename);
    const bytes = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(dest, bytes);
    staged.push({
      filename,
      absolutePath: dest,
      contentType: file.type || null,
      size: file.size,
    });
  }
  return staged;
}

/**
 * Render the attachment list for inclusion in the EA prompt. The EA
 * agent has filesystem access via claude-code, so we give it absolute
 * paths and @file references.
 */
export function renderEaAttachmentSection(attachments: EaAttachment[]): string {
  if (attachments.length === 0) return "";
  const lines: string[] = [
    "",
    "## Owner attached the following file(s) to this message",
    "Use these @file references or your Read tool to inspect them. Image and PDF attachments render visually.",
  ];
  for (const attachment of attachments) {
    const meta = [
      attachment.contentType ?? "unknown type",
      `${(attachment.size / 1024).toFixed(1)} KB`,
    ].join(", ");
    lines.push(
      `- @${attachment.absolutePath} (${attachment.filename}, ${meta})`,
    );
  }
  return lines.join("\n");
}
