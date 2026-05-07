import type { SkillCandidateEvidence } from "@/skills/self-creation";

export interface CaptureDraftPreview {
  version: 1;
  title: string;
  slug: string;
  roleSlug: string;
  scope: "hive";
  observedSteps: string[];
  inferredInputs: string[];
  decisionNotes: string[];
  confidence: {
    level: "low" | "medium" | "high";
    score: number;
    rationale: string;
  };
  sensitiveDataWarnings: string[];
  redactionNotes: string[];
  suggestedSkillContent: string;
  source: {
    captureSessionId: string;
    hiveId: string;
    fieldsUsed: Array<"metadata" | "evidenceSummary" | "redactedSummary" | "captureScope">;
    rawMediaAccepted: false;
  };
}

export interface CaptureDraftMetadata {
  preview?: CaptureDraftPreview;
  previewStatus?: "generated" | "rejected" | "approved";
  approvedDraftId?: string;
  approvedDraftStatus?: string;
  rejectedAt?: string;
  rejectionReason?: string;
}

const DEFAULT_STEP = "Review the captured metadata and write the intended workflow steps.";
const DEFAULT_INPUT = "Owner-provided workflow details";
const DEFAULT_NOTE = "Only metadata and redacted summaries were available; raw media was not uploaded or analyzed.";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean)
    .slice(0, 20);
}

function collectStringArrays(
  source: Record<string, unknown> | null,
  keys: string[],
): string[] {
  if (!source) return [];
  const values = keys.flatMap((key) => asStringArray(source[key]));
  return [...new Set(values)];
}

function firstString(source: Record<string, unknown> | null, keys: string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function slugifyCaptureDraftTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return slug || "capture-session-workflow";
}

function markdownList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function buildSkillContent(input: {
  title: string;
  observedSteps: string[];
  inferredInputs: string[];
  decisionNotes: string[];
  sensitiveDataWarnings: string[];
  redactionNotes: string[];
  confidence: CaptureDraftPreview["confidence"];
}): string {
  return `# ${input.title}

## Purpose

Use this draft as a reviewed starting point for a future workflow skill. It was generated from metadata-only capture evidence and must be QA reviewed before use.

## Observed steps

${markdownList(input.observedSteps)}

## Inputs and placeholders

${markdownList(input.inferredInputs)}

## Decision notes

${markdownList(input.decisionNotes)}

## Safety and redaction notes

${markdownList([...input.sensitiveDataWarnings, ...input.redactionNotes])}

## Confidence

${input.confidence.level} (${input.confidence.score.toFixed(2)}): ${input.confidence.rationale}
`;
}

export function generateCaptureDraftPreview(
  row: Record<string, unknown>,
): CaptureDraftPreview {
  const metadata = asRecord(row.metadata);
  const evidenceSummary = asRecord(row.evidence_summary);
  const captureScope = asRecord(row.capture_scope);
  const redactedSummary =
    typeof row.redacted_summary === "string" ? row.redacted_summary.trim() : "";

  const title =
    firstString(metadata, ["title", "workflowTitle", "name"]) ??
    firstString(evidenceSummary, ["title", "workflowTitle", "name"]) ??
    "Captured workflow draft";

  const observedSteps = collectStringArrays(metadata, [
    "observedSteps",
    "steps",
    "actions",
    "events",
  ]).concat(collectStringArrays(evidenceSummary, ["observedSteps", "steps", "actions"]));

  const inferredInputs = collectStringArrays(metadata, [
    "inferredInputs",
    "inputs",
    "placeholders",
  ]).concat(collectStringArrays(evidenceSummary, ["inferredInputs", "inputs", "placeholders"]));

  const decisionNotes = collectStringArrays(metadata, [
    "decisionNotes",
    "decisions",
    "notes",
  ]).concat(collectStringArrays(evidenceSummary, ["decisionNotes", "decisions", "notes"]));

  const sensitiveDataWarnings = collectStringArrays(metadata, [
    "sensitiveDataWarnings",
    "sensitiveWarnings",
  ]).concat(collectStringArrays(evidenceSummary, [
    "sensitiveDataWarnings",
    "sensitiveWarnings",
  ]));

  const redactionNotes = collectStringArrays(metadata, ["redactionNotes"])
    .concat(collectStringArrays(evidenceSummary, ["redactionNotes"]));

  if (redactedSummary) {
    decisionNotes.push(`Redacted summary: ${redactedSummary}`);
  }
  if (captureScope) {
    decisionNotes.push(`Capture scope: ${JSON.stringify(captureScope)}`);
  }

  const uniqueObservedSteps = [...new Set(observedSteps)];
  const uniqueInferredInputs = [...new Set(inferredInputs)];
  const uniqueDecisionNotes = [...new Set(decisionNotes)];
  const uniqueSensitiveWarnings = [...new Set(sensitiveDataWarnings)];
  const uniqueRedactionNotes = [...new Set(redactionNotes)];

  const normalizedObservedSteps = uniqueObservedSteps.length
    ? uniqueObservedSteps
    : [DEFAULT_STEP];
  const normalizedInputs = uniqueInferredInputs.length
    ? uniqueInferredInputs
    : [DEFAULT_INPUT];
  const normalizedDecisionNotes = uniqueDecisionNotes.length
    ? uniqueDecisionNotes
    : [DEFAULT_NOTE];
  const normalizedSensitiveWarnings = uniqueSensitiveWarnings.length
    ? uniqueSensitiveWarnings
    : ["Check the draft for credentials, customer data, financial data, and private owner context before approval."];
  const normalizedRedactionNotes = uniqueRedactionNotes.length
    ? uniqueRedactionNotes
    : ["Raw video, audio, screenshots, frames, and binary media were not uploaded or analyzed."];

  const evidenceScore =
    (uniqueObservedSteps.length ? 0.45 : 0) +
    (uniqueInferredInputs.length ? 0.2 : 0) +
    (uniqueDecisionNotes.length || redactedSummary ? 0.2 : 0) +
    (uniqueRedactionNotes.length || uniqueSensitiveWarnings.length ? 0.15 : 0);
  const score = Number(Math.max(0.25, Math.min(0.9, evidenceScore)).toFixed(2));
  const level = score >= 0.75 ? "high" : score >= 0.5 ? "medium" : "low";
  const confidence = {
    level,
    score,
    rationale: level === "low"
      ? "The capture has sparse metadata, so the draft needs owner editing before QA review."
      : "The capture includes enough structured metadata for a reviewable first draft.",
  } satisfies CaptureDraftPreview["confidence"];

  const suggestedSkillContent = buildSkillContent({
    title,
    observedSteps: normalizedObservedSteps,
    inferredInputs: normalizedInputs,
    decisionNotes: normalizedDecisionNotes,
    sensitiveDataWarnings: normalizedSensitiveWarnings,
    redactionNotes: normalizedRedactionNotes,
    confidence,
  });

  return {
    version: 1,
    title,
    slug: slugifyCaptureDraftTitle(title),
    roleSlug: "owner",
    scope: "hive",
    observedSteps: normalizedObservedSteps,
    inferredInputs: normalizedInputs,
    decisionNotes: normalizedDecisionNotes,
    confidence,
    sensitiveDataWarnings: normalizedSensitiveWarnings,
    redactionNotes: normalizedRedactionNotes,
    suggestedSkillContent,
    source: {
      captureSessionId: row.id as string,
      hiveId: row.hive_id as string,
      fieldsUsed: ["metadata", "evidenceSummary", "redactedSummary", "captureScope"],
      rawMediaAccepted: false,
    },
  };
}

export function getCaptureDraftMetadata(
  metadata: Record<string, unknown> | null | undefined,
): CaptureDraftMetadata {
  const captureDraft = asRecord(metadata?.captureDraft);
  if (!captureDraft) return {};
  return captureDraft as CaptureDraftMetadata;
}

export function buildCaptureDraftEvidence(
  preview: CaptureDraftPreview,
): SkillCandidateEvidence[] {
  return [
    {
      type: "manual",
      summary: `Approved from metadata-only capture session ${preview.source.captureSessionId}. Raw media accepted: false.`,
      source: `capture-session:${preview.source.captureSessionId}`,
    },
  ];
}
