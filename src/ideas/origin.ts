export interface IdeaOriginMetadata {
  ideaId: string;
  title: string;
  preface: string;
  remainder: string;
}

const IDEA_ORIGIN_PREFIX = /^From your idea ([0-9a-fA-F-]{36}): (.+)$/;

export function buildIdeaOriginPreface(ideaId: string, title: string): string {
  return `From your idea ${ideaId}: ${title.trim()}`;
}

export function prependIdeaOriginPreface(
  goalBrief: string,
  ideaId: string,
  title: string,
): string {
  const trimmed = goalBrief.trim();
  const preface = buildIdeaOriginPreface(ideaId, title);
  if (!trimmed) return preface;

  const paragraphs = trimmed.split(/\n\s*\n/);
  const firstParagraph = paragraphs[0]?.trim() ?? "";
  if (firstParagraph === preface) return trimmed;

  if (firstParagraph.includes(ideaId)) {
    return [preface, ...paragraphs.slice(1)].join("\n\n").trim();
  }

  return `${preface}\n\n${trimmed}`;
}

export function extractIdeaOriginMetadata(text: string): IdeaOriginMetadata | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const paragraphs = trimmed.split(/\n\s*\n/);
  const firstParagraph = paragraphs[0]?.trim() ?? "";
  const match = IDEA_ORIGIN_PREFIX.exec(firstParagraph);
  if (!match) return null;

  return {
    ideaId: match[1],
    title: match[2],
    preface: firstParagraph,
    remainder: paragraphs.slice(1).join("\n\n").trim(),
  };
}
