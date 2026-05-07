import type { Sql } from "postgres";

interface HiveRow {
  name: string;
  type: string;
  description: string | null;
  mission: string | null;
}

interface TargetRow {
  title: string;
  target_value: string | null;
  deadline: Date | null;
}

const MISSION_WORD_CAP = 500;

function capMission(mission: string): string {
  const words = mission.split(/\s+/).filter(Boolean);
  if (words.length <= MISSION_WORD_CAP) return mission;
  console.warn(
    `[buildHiveContextBlock] mission truncated from ${words.length} to ${MISSION_WORD_CAP} words`,
  );
  return `${words.slice(0, MISSION_WORD_CAP).join(" ")} … [mission truncated to 500 words]`;
}

/**
 * Build the shared "## Hive Context" markdown block injected into every
 * agent spawn (EA, goal supervisor, executor). Returns "" when the hive id
 * is unknown so callers can safely concatenate without a null check.
 */
export async function buildHiveContextBlock(
  sql: Sql,
  hiveId: string,
  workspacePath?: string | null,
): Promise<string> {
  const [hive] = await sql<HiveRow[]>`
    SELECT name, type, description, mission
    FROM hives WHERE id = ${hiveId}
  `;
  if (!hive) return "";

  const targets = await sql<TargetRow[]>`
    SELECT title, target_value, deadline
    FROM hive_targets
    WHERE hive_id = ${hiveId} AND status = 'open'
    ORDER BY sort_order ASC, created_at ASC
  `;

  const lines: string[] = ["## Hive Context"];
  lines.push(`**Hive:** ${hive.name}`);
  lines.push(`**Type:** ${hive.type}`);
  if (hive.description) lines.push(`**About:** ${hive.description}`);
  if (workspacePath) lines.push(`**Working in:** ${workspacePath}`);

  if (hive.mission) {
    lines.push("");
    lines.push("**Mission:**");
    lines.push(capMission(hive.mission));
  }

  if (targets.length > 0) {
    lines.push("");
    lines.push("**Targets:**");
    for (const t of targets) {
      const parts = [`- ${t.title}`];
      if (t.target_value) parts[0] += `: ${t.target_value}`;
      if (t.deadline) {
        const iso = t.deadline instanceof Date
          ? t.deadline.toISOString().slice(0, 10)
          : String(t.deadline).slice(0, 10);
        parts.push(`(by ${iso})`);
      }
      lines.push(parts.join(" "));
    }
  }

  return lines.join("\n");
}
