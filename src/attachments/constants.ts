export const MAX_ATTACHMENT_FILE_SIZE = 25 * 1024 * 1024;
export const MAX_ATTACHMENT_FILES = 10;

export function validateAttachmentFiles(files: File[]): string | null {
  if (files.length > MAX_ATTACHMENT_FILES) {
    return `Too many files. Maximum ${MAX_ATTACHMENT_FILES} files per submission.`;
  }

  const oversized = files.find((file) => file.size > MAX_ATTACHMENT_FILE_SIZE);
  if (oversized) {
    return `File "${oversized.name}" exceeds the 25 MB size limit.`;
  }

  return null;
}
