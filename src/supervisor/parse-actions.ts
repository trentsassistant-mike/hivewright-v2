import type {
  ParseSupervisorActionsResult,
  SupervisorAction,
  SupervisorActionKind,
  SupervisorActions,
} from "./types";

/**
 * Parses the supervisor agent's structured-output block. Mirrors
 * `parseDoctorDiagnosis` — the contract is a fenced ```json block whose
 * body is a `SupervisorActions` object. Multiple blocks → we use the LAST
 * one (the agent may "draft" earlier in its reasoning).
 *
 * Negative paths carry a `kind` discriminator (`no_block` | `malformed` |
 * `invalid_shape`) so the supervisor runtime can route malformed output
 * to an ea_review Tier 3 decision with targeted context.
 */

// Case-insensitive on the language tag — some LLMs emit ```JSON.
const FENCED_JSON_RE = /```json\s*\n([\s\S]*?)\n\s*```/gi;

const VALID_KINDS: ReadonlySet<SupervisorActionKind> = new Set([
  "spawn_followup",
  "wake_goal",
  "create_decision",
  "close_task",
  "mark_unresolvable",
  "log_insight",
  "noop",
]);

export function parseSupervisorActions(
  output: string,
): ParseSupervisorActionsResult {
  const matches = [...output.matchAll(FENCED_JSON_RE)];
  if (matches.length === 0) {
    return {
      ok: false,
      kind: "no_block",
      error: "No ```json block found in supervisor output.",
    };
  }
  const raw = matches[matches.length - 1][1];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      kind: "malformed",
      error: `Supervisor actions JSON malformed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      kind: "malformed",
      error: "Supervisor actions JSON malformed: root must be an object.",
    };
  }

  const root = parsed as Record<string, unknown>;

  if (typeof root.summary !== "string") {
    return {
      ok: false,
      kind: "invalid_shape",
      error: "SupervisorActions missing string 'summary' field.",
    };
  }
  if (!Array.isArray(root.findings_addressed)) {
    return {
      ok: false,
      kind: "invalid_shape",
      error: "SupervisorActions missing array 'findings_addressed' field.",
    };
  }
  for (const f of root.findings_addressed) {
    if (typeof f !== "string") {
      return {
        ok: false,
        kind: "invalid_shape",
        error: "SupervisorActions.findings_addressed entries must be strings.",
      };
    }
  }
  if (!Array.isArray(root.actions)) {
    return {
      ok: false,
      kind: "invalid_shape",
      error: "SupervisorActions missing array 'actions' field.",
    };
  }

  const actions: SupervisorAction[] = [];
  for (const [idx, a] of root.actions.entries()) {
    const validated = validateAction(a, idx);
    if (!validated.ok) return validated;
    actions.push(validated.value);
  }

  const value: SupervisorActions = {
    summary: root.summary,
    findings_addressed: root.findings_addressed as string[],
    actions,
  };
  return { ok: true, value };
}

function validateAction(
  raw: unknown,
  idx: number,
):
  | { ok: true; value: SupervisorAction }
  | { ok: false; kind: "invalid_shape"; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      kind: "invalid_shape",
      error: `actions[${idx}] must be an object.`,
    };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.kind !== "string") {
    return {
      ok: false,
      kind: "invalid_shape",
      error: `actions[${idx}] missing string 'kind' field.`,
    };
  }
  if (!VALID_KINDS.has(obj.kind as SupervisorActionKind)) {
    return {
      ok: false,
      kind: "invalid_shape",
      error: `actions[${idx}] unknown action kind: ${obj.kind}`,
    };
  }

  switch (obj.kind as SupervisorActionKind) {
    case "spawn_followup":
      return requireStrings(obj, idx, [
        "originalTaskId",
        "assignedTo",
        "title",
        "brief",
      ]);
    case "wake_goal":
      return requireStrings(obj, idx, ["goalId", "reasoning"]);
    case "create_decision": {
      if (obj.tier !== 2 && obj.tier !== 3) {
        return {
          ok: false,
          kind: "invalid_shape",
          error: `actions[${idx}].tier must be 2 or 3 (got ${String(obj.tier)}).`,
        };
      }
      if (obj.options !== undefined) {
        const optionsResult = validateDecisionOptions(obj.options, idx);
        if (!optionsResult.ok) return optionsResult;
      }
      return requireStrings(obj, idx, ["title", "context"], [
        "recommendation",
      ]);
    }
    case "close_task":
      return requireStrings(obj, idx, ["taskId", "note"]);
    case "mark_unresolvable":
      return requireStrings(obj, idx, ["taskId", "reason"]);
    case "log_insight":
      return requireStrings(obj, idx, ["category", "content"]);
    case "noop":
      return requireStrings(obj, idx, ["reasoning"]);
  }
}

function requireStrings(
  obj: Record<string, unknown>,
  idx: number,
  required: string[],
  optional: string[] = [],
):
  | { ok: true; value: SupervisorAction }
  | { ok: false; kind: "invalid_shape"; error: string } {
  for (const field of required) {
    if (typeof obj[field] !== "string" || (obj[field] as string).trim() === "") {
      return {
        ok: false,
        kind: "invalid_shape",
        error: `actions[${idx}].${field} must be a non-empty string.`,
      };
    }
  }
  for (const field of optional) {
    if (obj[field] !== undefined && typeof obj[field] !== "string") {
      return {
        ok: false,
        kind: "invalid_shape",
        error: `actions[${idx}].${field} must be a string when present.`,
      };
    }
  }
  return { ok: true, value: obj as unknown as SupervisorAction };
}

function validateDecisionOptions(
  raw: unknown,
  actionIdx: number,
): { ok: true } | { ok: false; kind: "invalid_shape"; error: string } {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      kind: "invalid_shape",
      error: `actions[${actionIdx}].options must be an array when present.`,
    };
  }
  for (const [optionIdx, option] of raw.entries()) {
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      return {
        ok: false,
        kind: "invalid_shape",
        error: `actions[${actionIdx}].options[${optionIdx}] must be an object.`,
      };
    }
    const record = option as Record<string, unknown>;
    for (const field of ["key", "label"]) {
      if (typeof record[field] !== "string" || record[field].trim() === "") {
        return {
          ok: false,
          kind: "invalid_shape",
          error: `actions[${actionIdx}].options[${optionIdx}].${field} must be a non-empty string.`,
        };
      }
    }
    for (const field of [
      "consequence",
      "description",
      "response",
      "canonicalResponse",
      "canonical_response",
    ]) {
      if (record[field] !== undefined && typeof record[field] !== "string") {
        return {
          ok: false,
          kind: "invalid_shape",
          error: `actions[${actionIdx}].options[${optionIdx}].${field} must be a string when present.`,
        };
      }
    }
  }
  return { ok: true };
}
