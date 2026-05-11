import type { Sql } from "postgres";
import { proposeSkill } from "@/skills/self-creation";
import type { LearningGateResult } from "./outcome-records";
import { LEARNING_GATE_FOLLOWUP_DECISION_KIND } from "./learning-gate-approval";

const MAX_TEXT_LENGTH = 700;
const MAX_MEMORY_LENGTH = 1_200;

interface LearningGateFollowupInput {
  goalId: string;
  hiveId: string;
  goalTitle: string;
  completionSummary: string;
  learningGate: LearningGateResult;
}

function compactText(value: string | undefined, maxLength = MAX_TEXT_LENGTH): string | null {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}...` : text;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 75);
  return slug || "goal";
}

function titleCaseCategory(category: LearningGateResult["category"]): string {
  const label = category.replace(/_/g, " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function learningSummary(input: LearningGateFollowupInput): { rationale: string; action: string | null; summary: string } {
  const rationale = compactText(input.learningGate.rationale) ?? "No rationale supplied.";
  const action = compactText(input.learningGate.action);
  const summary = compactText(input.completionSummary, 400) ?? "Goal completed.";
  return { rationale, action, summary };
}

async function createOwnerReviewDecision(
  sql: Sql,
  input: LearningGateFollowupInput,
  guidance: string,
): Promise<void> {
  const { rationale, action, summary } = learningSummary(input);
  const categoryLabel = titleCaseCategory(input.learningGate.category);
  const title = truncate(`${categoryLabel}: review reusable learning from ${input.goalTitle}`, 500);
  const context = [
    `Learning gate category: ${input.learningGate.category}`,
    `Completed goal: ${input.goalTitle} (${input.goalId})`,
    "",
    `Completion summary: ${summary}`,
    `Rationale: ${rationale}`,
    action ? `Proposed action: ${action}` : null,
    "",
    guidance,
  ].filter((line): line is string => line !== null).join("\n");

  await sql`
    INSERT INTO decisions (
      hive_id,
      goal_id,
      title,
      context,
      recommendation,
      options,
      priority,
      status,
      kind,
      route_metadata
    )
    VALUES (
      ${input.hiveId},
      ${input.goalId},
      ${title},
      ${context},
      ${action ?? rationale},
      ${sql.json([
        {
          key: "approve-followup",
          label: "Approve follow-up",
          consequence: "Allows the recommended reusable improvement to be implemented through the governed path.",
          response: "approved",
        },
        {
          key: "reject-followup",
          label: "Reject follow-up",
          consequence: "Leaves future behavior unchanged.",
          response: "rejected",
        },
      ] as unknown as Parameters<typeof sql.json>[0])},
      'normal',
      'pending',
      ${LEARNING_GATE_FOLLOWUP_DECISION_KIND},
      ${sql.json({
        learningGateFollowup: {
          category: input.learningGate.category,
          action,
          rationale,
          summary,
          goalId: input.goalId,
          goalTitle: input.goalTitle,
        },
      } as unknown as Parameters<typeof sql.json>[0])}
    )
  `;
}

async function createMemoryFollowup(sql: Sql, input: LearningGateFollowupInput): Promise<void> {
  const { rationale, action, summary } = learningSummary(input);
  const content = truncate([
    `Learning gate memory from completed goal "${input.goalTitle}".`,
    action ? `Memory: ${action}` : null,
    `Rationale: ${rationale}`,
    `Completion summary: ${summary}`,
  ].filter((line): line is string => line !== null).join("\n"), MAX_MEMORY_LENGTH);

  await sql`
    INSERT INTO hive_memory (hive_id, category, content, confidence, sensitivity)
    VALUES (${input.hiveId}, 'learning', ${content}, 0.9, 'internal')
  `;
}

async function createSkillFollowup(sql: Sql, input: LearningGateFollowupInput): Promise<void> {
  const { rationale, action, summary } = learningSummary(input);
  const slug = `${slugify(input.goalTitle)}-learning-gate-skill`.slice(0, 100);
  const content = [
    `# ${input.goalTitle} Learning Gate Skill Candidate`,
    "",
    "## Trigger",
    "",
    rationale,
    "",
    "## Candidate work",
    "",
    action ?? "Draft a reusable internal skill from this completed goal's verified approach.",
    "",
    "## Completion context",
    "",
    summary,
    "",
    "This is a reviewable skill draft. It must pass the governed skill lifecycle before roles depend on it.",
  ].join("\n");

  try {
    await proposeSkill(sql, {
      hiveId: input.hiveId,
      roleSlug: "goal-supervisor",
      targetRoleSlugs: ["goal-supervisor"],
      slug,
      content,
      scope: "hive",
      sourceType: "internal",
      internalSourceRef: `goal:${input.goalId}`,
      evidence: [{
        type: "manual",
        summary: [rationale, action].filter(Boolean).join("\n"),
        source: "goal-learning-gate",
      }],
    });
  } catch (error) {
    await createOwnerReviewDecision(
      sql,
      input,
      `Skill draft creation was blocked (${error instanceof Error ? error.message : "unknown error"}). Owner review is required before any reusable skill is adopted.`,
    );
  }
}

export async function createLearningGateFollowup(
  sql: Sql,
  input: LearningGateFollowupInput,
): Promise<void> {
  switch (input.learningGate.category) {
    case "nothing":
      return;
    case "memory":
      await createMemoryFollowup(sql, input);
      return;
    case "skill":
      await createSkillFollowup(sql, input);
      return;
    case "template":
      await createOwnerReviewDecision(
        sql,
        input,
        "This template candidate requires review before it is saved as reusable structure for future work.",
      );
      return;
    case "policy_candidate":
      await createOwnerReviewDecision(
        sql,
        input,
        "This policy candidate requires owner review before becoming a standing instruction, rule, or mandatory policy. No restrictive future behavior has been activated.",
      );
      return;
    case "pipeline_candidate":
      await createOwnerReviewDecision(
        sql,
        input,
        "This pipeline candidate requires owner review before any pipeline is activated or made mandatory. No active pipeline template or run has been created.",
      );
      return;
    case "update_existing":
      await createOwnerReviewDecision(
        sql,
        input,
        "This update-existing recommendation requires review before updating existing reusable behavior.",
      );
      return;
  }
}
