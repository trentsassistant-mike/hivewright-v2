import { extractIdeaOriginMetadata } from "@/ideas/origin";

const FALLBACK_MESSAGE =
  "Supervisor is starting now — first sprint will appear in the dashboard within a couple of minutes.";

function truncateMessage(text: string, maxLength = 400): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function buildGoalCreatedNotificationMessage(description: string | null): string {
  const trimmed = description?.trim();
  if (!trimmed) return FALLBACK_MESSAGE;

  const ideaOrigin = extractIdeaOriginMetadata(trimmed);
  if (!ideaOrigin) return truncateMessage(trimmed);
  if (!ideaOrigin.remainder) return ideaOrigin.preface;

  return `${ideaOrigin.preface}\n\n${truncateMessage(ideaOrigin.remainder)}`;
}
