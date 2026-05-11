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

interface StandingInstructionRow {
  content: string;
}

interface PolicyMemoryRow {
  category: string;
  content: string;
}

const MISSION_WORD_CAP = 500;
const MAX_POLICY_CONTEXT_ITEMS = 5;
const POLICY_CONTEXT_CHAR_CAP = 320;
const POLICY_MEMORY_MIN_CONFIDENCE = 0.8;
const POLICY_MEMORY_PATTERN =
  "(policy|rule|procedure|process|must|never|always|required|approval|owner approval|do not)";

function capMission(mission: string): string {
  const words = mission.split(/\s+/).filter(Boolean);
  if (words.length <= MISSION_WORD_CAP) return mission;
  console.warn(
    `[buildHiveContextBlock] mission truncated from ${words.length} to ${MISSION_WORD_CAP} words`,
  );
  return `${words.slice(0, MISSION_WORD_CAP).join(" ")} … [mission truncated to 500 words]`;
}

function capContextItem(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= POLICY_CONTEXT_CHAR_CAP) return normalized;
  return `${normalized.slice(0, POLICY_CONTEXT_CHAR_CAP).trimEnd()} … [truncated]`;
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

  const standingInstructions = await sql<StandingInstructionRow[]>`
    SELECT content
    FROM standing_instructions
    WHERE hive_id = ${hiveId}
    ORDER BY confidence DESC, created_at ASC, id ASC
    LIMIT ${MAX_POLICY_CONTEXT_ITEMS}
  `;

  const policyMemories = await sql<PolicyMemoryRow[]>`
    SELECT category, content
    FROM hive_memory
    WHERE hive_id = ${hiveId}
      AND superseded_by IS NULL
      AND sensitivity != 'restricted'
      AND confidence >= ${POLICY_MEMORY_MIN_CONFIDENCE}
      AND content ~* ${POLICY_MEMORY_PATTERN}
    ORDER BY confidence DESC, updated_at DESC, created_at ASC, id ASC
    LIMIT ${MAX_POLICY_CONTEXT_ITEMS}
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

  if (standingInstructions.length > 0 || policyMemories.length > 0) {
    lines.push("");
    lines.push("**Policies / Rules / Owner Procedures:**");
    if (standingInstructions.length > 0) {
      lines.push("Standing instructions are owner-defined guidance/procedures and are mandatory when applicable.");
      for (const instruction of standingInstructions) {
        lines.push(`- [standing instruction] ${capContextItem(instruction.content)}`);
      }
    }
    for (const memory of policyMemories) {
      lines.push(`- [hive memory: ${memory.category}] ${capContextItem(memory.content)}`);
    }
  }

  return lines.join("\n");
}
