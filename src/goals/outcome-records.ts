import type { Sql } from "postgres";

export const OUTCOME_CLASSIFICATIONS = ["outcome-led", "process-bound"] as const;
export type OutcomeClassification = typeof OUTCOME_CLASSIFICATIONS[number];

export const LEARNING_GATE_CATEGORIES = [
  "memory",
  "skill",
  "template",
  "policy_candidate",
  "pipeline_candidate",
  "update_existing",
  "nothing",
] as const;
export type LearningGateCategory = typeof LEARNING_GATE_CATEGORIES[number];

export interface OutcomeReference {
  type: string;
  id?: string;
  slug?: string;
  title?: string;
  source?: string;
  note?: string;
}

export interface OutcomeClassificationRecord {
  classification: OutcomeClassification;
  rationale: string;
  references: OutcomeReference[];
  classifiedBy: string;
}

export interface LearningGateResult {
  category: LearningGateCategory;
  rationale: string;
  action?: string;
  references?: OutcomeReference[];
}

export const DEFAULT_LEARNING_GATE_RESULT: LearningGateResult = {
  category: "nothing",
  rationale: "No reusable learning gate result was supplied.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normaliseReferences(value: unknown): { ok: true; references: OutcomeReference[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, references: [] };
  if (!Array.isArray(value)) return { ok: false, error: "references must be an array" };

  const references: OutcomeReference[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      return { ok: false, error: `references[${index}] must be an object` };
    }
    const type = readNonEmptyString(item.type);
    if (!type) {
      return { ok: false, error: `references[${index}].type must be a non-empty string` };
    }
    const reference: OutcomeReference = { type };
    for (const key of ["id", "slug", "title", "source", "note"] as const) {
      const text = readNonEmptyString(item[key]);
      if (text) reference[key] = text;
    }
    references.push(reference);
  }
  return { ok: true, references };
}

export function hasOutcomeClassificationInput(args: Record<string, unknown>): boolean {
  return [
    "classification",
    "outcome_classification",
    "rationale",
    "classification_rationale",
    "outcome_classification_rationale",
    "references",
    "applicable_references",
    "outcome_references",
    "process_references",
  ].some((key) => Object.hasOwn(args, key));
}

export function parseOutcomeClassificationRecord(
  args: Record<string, unknown>,
  classifiedBy = "goal-supervisor",
): { ok: true; record: OutcomeClassificationRecord } | { ok: false; error: string } {
  const classification = readNonEmptyString(args.classification ?? args.outcome_classification);
  if (!classification || !OUTCOME_CLASSIFICATIONS.includes(classification as OutcomeClassification)) {
    return {
      ok: false,
      error: `classification must be one of: ${OUTCOME_CLASSIFICATIONS.join(", ")}`,
    };
  }

  const rationale = readNonEmptyString(
    args.rationale ??
      args.classification_rationale ??
      args.outcome_classification_rationale,
  );
  if (!rationale) {
    return { ok: false, error: "classification rationale must be a non-empty string" };
  }

  const references = normaliseReferences(
    args.references ??
      args.applicable_references ??
      args.outcome_references ??
      args.process_references,
  );
  if (!references.ok) return { ok: false, error: references.error };

  return {
    ok: true,
    record: {
      classification: classification as OutcomeClassification,
      rationale,
      references: references.references,
      classifiedBy,
    },
  };
}

export function parseLearningGateResult(
  value: unknown,
): { ok: true; result: LearningGateResult } | { ok: false; error: string } {
  if (value === undefined || value === null) {
    return { ok: true, result: DEFAULT_LEARNING_GATE_RESULT };
  }
  if (!isRecord(value)) return { ok: false, error: "learningGate must be an object" };

  const category = readNonEmptyString(value.category);
  if (!category || !LEARNING_GATE_CATEGORIES.includes(category as LearningGateCategory)) {
    return {
      ok: false,
      error: `learningGate.category must be one of: ${LEARNING_GATE_CATEGORIES.join(", ")}`,
    };
  }

  const rationale = readNonEmptyString(value.rationale);
  if (!rationale) return { ok: false, error: "learningGate.rationale must be a non-empty string" };

  const references = normaliseReferences(value.references);
  if (!references.ok) return { ok: false, error: `learningGate.${references.error}` };

  const result: LearningGateResult = {
    category: category as LearningGateCategory,
    rationale,
  };
  const action = readNonEmptyString(value.action);
  if (action) result.action = action;
  if (references.references.length > 0) result.references = references.references;
  return { ok: true, result };
}

export async function recordGoalOutcomeClassification(
  sql: Sql,
  goalId: string,
  record: OutcomeClassificationRecord,
): Promise<boolean> {
  const rows = await sql`
    UPDATE goals
    SET outcome_classification = ${record.classification},
        outcome_classification_rationale = ${record.rationale},
        outcome_process_references = ${sql.json(record.references as unknown as Parameters<typeof sql.json>[0])},
        outcome_classified_by = ${record.classifiedBy},
        outcome_classified_at = NOW(),
        updated_at = NOW()
    WHERE id = ${goalId}
    RETURNING id
  `;
  return rows.length > 0;
}
