import type { Sql } from "postgres";

export class DefaultProjectResolutionError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "DefaultProjectResolutionError";
    this.status = status;
  }
}

export async function resolveDefaultProjectIdForHive(
  sql: Sql,
  hiveId: string,
  explicitProjectId: string | null | undefined,
): Promise<string | null> {
  const normalized = typeof explicitProjectId === "string" && explicitProjectId.trim() !== ""
    ? explicitProjectId
    : null;
  void sql;
  void hiveId;
  return normalized;
}
