import type { ClassifierResult } from "./types";

/**
 * Scans `text` for the first syntactically-balanced JSON object and returns
 * its raw string. Handles prose around/before the JSON and fenced code blocks.
 * Returns null if no balanced object is found.
 */
export function extractFirstJsonBlock(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function isValidClassifierResult(x: unknown): x is NonNullable<ClassifierResult> {
  if (!x || typeof x !== "object") return false;
  const obj = x as Record<string, unknown>;
  if (obj.type !== "task" && obj.type !== "goal") return false;
  if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence)) return false;
  if (obj.confidence < 0 || obj.confidence > 1) return false;
  if (typeof obj.reasoning !== "string" || obj.reasoning.length === 0) return false;
  if (obj.type === "task") {
    if (typeof obj.role !== "string" || obj.role.length === 0) return false;
  }
  return true;
}
