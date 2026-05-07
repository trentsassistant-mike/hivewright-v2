import type { Sql, TransactionSql } from "postgres";
import {
  prepareAttachmentWrite,
  removeAttachmentFile,
  writePreparedAttachment,
} from "@/attachments/writer";

type AttachmentParent = {
  taskId?: string | null;
  goalId?: string | null;
  ideaId?: string | null;
};

export async function persistAttachmentsForParent(
  db: Sql | TransactionSql,
  hiveId: string,
  parentId: string,
  files: File[],
  parent: AttachmentParent,
) {
  if (files.length === 0) return;

  const [hive] = await db`SELECT slug FROM hives WHERE id = ${hiveId}`;
  const hiveSlug = hive?.slug as string | undefined;
  if (!hiveSlug) {
    throw new Error("Hive not found");
  }

  for (const file of files) {
    const attachment = prepareAttachmentWrite(hiveSlug, parentId, file);
    const [row] = await db<{ id: string }[]>`
      INSERT INTO task_attachments (
        task_id,
        goal_id,
        idea_id,
        filename,
        storage_path,
        mime_type,
        size_bytes
      )
      VALUES (
        ${parent.taskId ?? null},
        ${parent.goalId ?? null},
        ${parent.ideaId ?? null},
        ${attachment.filename},
        ${attachment.storagePath},
        ${attachment.mimeType},
        ${attachment.sizeBytes}
      )
      RETURNING id
    `;

    try {
      await writePreparedAttachment(attachment, file);
    } catch (error) {
      await db`
        DELETE FROM task_attachments
        WHERE id = ${row.id}
      `;
      removeAttachmentFile(attachment.storagePath);
      throw error;
    }
  }
}
