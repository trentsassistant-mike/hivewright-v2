export type IdeaStatus = "open" | "reviewed" | "promoted" | "archived";

const VALID_STATUSES: ReadonlySet<string> = new Set([
  "open",
  "reviewed",
  "promoted",
  "archived",
]);

export function isValidStatus(v: unknown): v is IdeaStatus {
  return typeof v === "string" && VALID_STATUSES.has(v);
}
