export type TargetStatus = "open" | "achieved" | "abandoned";

const VALID_STATUSES: ReadonlySet<string> = new Set(["open", "achieved", "abandoned"]);

export function isValidStatus(v: unknown): v is TargetStatus {
  return typeof v === "string" && VALID_STATUSES.has(v);
}
