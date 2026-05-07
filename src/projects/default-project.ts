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
  if (normalized) return normalized;

  const projects = await sql<{ id: string }[]>`
    SELECT id
    FROM projects
    WHERE hive_id = ${hiveId}
    ORDER BY created_at ASC, id ASC
    LIMIT 2
  `;

  if (projects.length === 0) return null;
  if (projects.length === 1) return projects[0].id;

  throw new DefaultProjectResolutionError("Hive has multiple projects; specify project_id.");
}
