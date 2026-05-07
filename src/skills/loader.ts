import fs from "fs";
import path from "path";
import type { LoadedSkill } from "./types";

const MAX_SKILLS_PER_TASK = 3;

export function loadSystemSkills(libraryPath: string): LoadedSkill[] {
  if (!fs.existsSync(libraryPath)) return [];

  const entries = fs.readdirSync(libraryPath, { withFileTypes: true });
  const skills: LoadedSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(libraryPath, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    skills.push({
      slug: entry.name,
      content: fs.readFileSync(skillMdPath, "utf-8"),
      tier: "system",
    });
  }

  return skills;
}

export function loadHiveSkills(hiveSkillsPath: string): LoadedSkill[] {
  if (!fs.existsSync(hiveSkillsPath)) return [];

  const entries = fs.readdirSync(hiveSkillsPath, { withFileTypes: true });
  const skills: LoadedSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(hiveSkillsPath, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) continue;

    skills.push({
      slug: entry.name,
      content: fs.readFileSync(skillMdPath, "utf-8"),
      tier: "hive",
    });
  }

  return skills;
}

/**
 * Resolve skills for a task. Hive skills override system skills on name conflict.
 * Returns formatted skill content strings (max 3).
 */
export function resolveSkillsForTask(
  allSkills: LoadedSkill[],
  requestedSlugs: string[],
): string[] {
  // Deduplicate slugs
  const uniqueSlugs = [...new Set(requestedSlugs)];

  // Build slug→skill map (hive overrides system)
  const skillMap = new Map<string, LoadedSkill>();
  for (const skill of allSkills) {
    if (!skillMap.has(skill.slug) || skill.tier === "hive") {
      skillMap.set(skill.slug, skill);
    }
  }

  const matched: string[] = [];
  for (const slug of uniqueSlugs) {
    const skill = skillMap.get(slug);
    if (skill) {
      matched.push(`## Skill: ${skill.slug}\n\n${skill.content}`);
    }
    if (matched.length >= MAX_SKILLS_PER_TASK) break;
  }

  return matched;
}
