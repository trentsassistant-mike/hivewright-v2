import type { ModelRoutingProfile } from "./profiles";

export type RoutingClassificationConfidence = "high" | "medium" | "low";

export interface ModelRoutingTaskContext {
  roleSlug: string;
  roleType: string | null;
  taskTitle?: string | null;
  taskBrief?: string | null;
  acceptanceCriteria?: string | string[] | null;
  retryCount?: number | null;
}

export interface ModelRoutingTaskClassification {
  profile: ModelRoutingProfile;
  confidence: RoutingClassificationConfidence;
  signals: string[];
  constraints: {
    requiresTools: boolean;
    requiresVision: boolean;
    highRiskDomain: boolean;
    estimatedContextTokens: number | null;
  };
}

const HIGH_RISK_DOMAIN_PATTERN = /\b(legal|law|finance|medical|healthcare|patient|clinical|compliance)\b|\bhealth\s+advice\b/i;
const CODING_PATTERN = /\b(implementation|code(?!-)|test|bug|fix|refactor|migration|typescript|react)\b/i;
const TOOL_PATTERN = /\b(tool|connector|mcp|api|sync|webhook)\b/i;
const WRITING_PATTERN = /\b(write|draft|copy|announcement|article|narrative|document|documentation)\b/i;
const SUMMARIZATION_PATTERN = /\b(summarize|summary|condense|digest)\b/i;
const RESEARCH_PATTERN = /\b(research(?!-)|investigate|find|compare|source)\b/i;
const VISION_PATTERN = /\b(screenshot|image|vision|visual)\b/i;

const ROLE_DEFAULTS: Record<string, ModelRoutingProfile> = {
  "goal-supervisor": "analysis",
  qa: "analysis",
  "qa-reviewer": "analysis",
  "frontend-engineer": "coding",
  "backend-engineer": "coding",
  "software-engineer": "coding",
  "dev-agent": "coding",
  "hive-development-agent": "coding",
  "code-review-agent": "analysis",
  researcher: "research",
  "research-analyst": "research",
  writer: "writing",
  "content-writer": "writing",
  "system-health-auditor": "analysis",
};

export function classifyModelRoutingTask(
  input: ModelRoutingTaskContext,
): ModelRoutingTaskClassification {
  const text = taskText(input);
  const constraints = {
    requiresTools: TOOL_PATTERN.test(text),
    requiresVision: VISION_PATTERN.test(text),
    highRiskDomain: HIGH_RISK_DOMAIN_PATTERN.test(text),
    estimatedContextTokens: text.length > 0 ? Math.ceil(text.length / 4) : null,
  };

  if (Number(input.retryCount ?? 0) > 0) {
    return classification("fallback_strong", "high", ["retry"], constraints);
  }

  if (constraints.highRiskDomain) {
    return classification("domain_sensitive", "high", ["task mentions high-risk domain"], constraints);
  }

  if (SUMMARIZATION_PATTERN.test(text)) {
    return classification("summarization", "high", ["task mentions summarization work"], constraints);
  }

  if (CODING_PATTERN.test(text)) {
    return classification(
      "coding",
      "high",
      ["task mentions implementation/code/test work"],
      constraints,
    );
  }

  if (WRITING_PATTERN.test(text)) {
    return classification("writing", "high", ["task mentions writing work"], constraints);
  }

  if (RESEARCH_PATTERN.test(text)) {
    return classification("research", "high", ["task mentions research work"], constraints);
  }

  if (constraints.requiresTools) {
    return classification("tool_agent", "high", ["task mentions tool/connector work"], constraints);
  }

  const roleSlug = input.roleSlug.trim().toLowerCase();
  const roleDefault = ROLE_DEFAULTS[roleSlug] ?? (
    input.roleType === "system" ? "analysis" : "fast_simple"
  );

  return classification(
    roleDefault,
    "medium",
    [`role default profile: ${roleDefault}`],
    constraints,
  );
}

function classification(
  profile: ModelRoutingProfile,
  confidence: RoutingClassificationConfidence,
  signals: string[],
  constraints: ModelRoutingTaskClassification["constraints"],
): ModelRoutingTaskClassification {
  return {
    profile,
    confidence,
    signals,
    constraints,
  };
}

function taskText(input: ModelRoutingTaskContext): string {
  return [
    input.roleSlug,
    input.roleType ?? "",
    input.taskTitle,
    input.taskBrief,
    ...(Array.isArray(input.acceptanceCriteria)
      ? input.acceptanceCriteria
      : [input.acceptanceCriteria]),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
}
