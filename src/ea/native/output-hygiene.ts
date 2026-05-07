export interface OwnerVisibleEaReplyCleanup {
  text: string;
  removedInternalProcessText: string[];
}

const INTERNAL_PROCESS_LINE_PATTERNS = [
  /^using[-\s][\w:-]+?(?:\s+(?:skill|workflow|to)\b|:)/i,
  /^using\s+(?:the\s+)?[\w:-]+(?:\s+skill)?\s+to\b/i,
  /^workflow(?:\s+banner)?:/i,
  /^skill(?:\s+activation)?:/i,
  /^activating\b.*\b(?:skill|workflow|superpowers)\b/i,
  /^i(?:'|’)ll use\b.*\b(?:skill|workflow|superpowers)\b/i,
  /^i am using\b.*\b(?:skill|workflow|superpowers)\b/i,
];

function isInternalProcessLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return INTERNAL_PROCESS_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function cleanOwnerVisibleEaReply(text: string): OwnerVisibleEaReplyCleanup {
  const lines = text.split(/\r?\n/);
  const removedInternalProcessText: string[] = [];
  let index = 0;
  let sawInternalProcess = false;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      if (sawInternalProcess) removedInternalProcessText.push(line);
      index += 1;
      continue;
    }

    if (!isInternalProcessLine(line)) break;

    sawInternalProcess = true;
    removedInternalProcessText.push(line);
    index += 1;
  }

  if (!sawInternalProcess) {
    return { text, removedInternalProcessText: [] };
  }

  return {
    text: lines.slice(index).join("\n").trimStart(),
    removedInternalProcessText: removedInternalProcessText.filter((line) => line.trim()),
  };
}
