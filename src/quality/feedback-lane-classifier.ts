export type QualityFeedbackLane = "owner" | "ai_peer";

export interface QualityFeedbackLaneInput {
  title: string;
  brief: string;
  roleSlug: string;
  workProductSummary?: string | null;
}

export interface QualityFeedbackLaneClassification {
  lane: QualityFeedbackLane;
  reason: string;
}

const OWNER_PATTERNS = [
  /src\/app\/\(dashboard\)\//i,
  /\b(dashboard|page|screen|ui|ux|component|frontend|visual|copy|content)\b/i,
  /\b(settings|schedule|schedules|quality-feedback)\b.*\b(ui|page|screen|route|copy)\b/i,
  /\b(discord|voice|ea)\b.*\b(prompt|reply|message|response|behavior|behaviour)\b/i,
  /\bowner-facing\b/i,
];

const AI_PEER_PATTERNS = [
  /\b(api|backend|server|route handler|endpoint|auth|authorization|middleware)\b/i,
  /\b(database|db|migration|drizzle|schema|sql)\b/i,
  /\b(watchdog|infrastructure|dispatcher|doctor|sweeper|supervisor heartbeat)\b/i,
  /\b(internal doc|internal docs|handoff|audit|qa report|finding|diagnosis)\b/i,
  /\b(role-library|role library|adapter|connector|credential|token)\b/i,
  /\b(repo coordinates|file map|baseline|verification-only)\b/i,
];

export function classifyQualityFeedbackLane(
  input: QualityFeedbackLaneInput,
): QualityFeedbackLaneClassification {
  const haystack = [
    input.title,
    input.brief,
    input.roleSlug,
    input.workProductSummary ?? "",
  ].join("\n");

  const aiMatch = AI_PEER_PATTERNS.find((pattern) => pattern.test(haystack));
  if (aiMatch) {
    return {
      lane: "ai_peer",
      reason: `Matched internal technical pattern: ${aiMatch.source}`,
    };
  }

  const ownerMatch = OWNER_PATTERNS.find((pattern) => pattern.test(haystack));
  if (ownerMatch) {
    return {
      lane: "owner",
      reason: `Matched owner-evaluable pattern: ${ownerMatch.source}`,
    };
  }

  return {
    lane: "ai_peer",
    reason: "No deterministic owner-evaluable pattern matched; defaulted to AI peer review.",
  };
}
