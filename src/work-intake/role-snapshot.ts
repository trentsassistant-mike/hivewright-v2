import type { Sql } from "postgres";

const TTL_MS = 5 * 60 * 1000;

interface Entry {
  lines: string[];
  expiresAt: number;
}

let cache: Entry | null = null;

export function clearRoleSnapshotCache(): void {
  cache = null;
}

export async function getRoleSnapshot(sql: Sql): Promise<string[]> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.lines;
  }
  const rows = await sql<{ slug: string; department: string | null; role_md: string | null }[]>`
    SELECT slug, department, role_md
    FROM role_templates
    WHERE active = true AND type = 'executor'
    ORDER BY department ASC, slug ASC
  `;
  const lines = rows.map((r) => {
    const desc = firstNonHeadingLine(r.role_md ?? "") || "(no description)";
    const dept = r.department ?? "uncategorised";
    return `- ${r.slug} (${dept}): ${desc}`;
  });
  cache = { lines, expiresAt: Date.now() + TTL_MS };
  return lines;
}

function firstNonHeadingLine(md: string): string {
  const lines = md.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#")) continue;
    return trimmed;
  }
  return "";
}
