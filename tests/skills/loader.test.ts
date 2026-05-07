import { describe, it, expect } from "vitest";
import path from "path";
import { loadSystemSkills, loadHiveSkills, resolveSkillsForTask } from "@/skills/loader";

const SYSTEM_SKILLS_PATH = path.resolve(__dirname, "../../skills-library");

describe("loadSystemSkills", () => {
  it("loads skills from the skills-library directory", () => {
    const skills = loadSystemSkills(SYSTEM_SKILLS_PATH);
    expect(skills.length).toBeGreaterThanOrEqual(2);
    expect(skills.some((s) => s.slug === "blog-writing")).toBe(true);
    expect(skills.some((s) => s.slug === "xero-reconciliation")).toBe(true);
  });

  it("each skill has slug and content", () => {
    const skills = loadSystemSkills(SYSTEM_SKILLS_PATH);
    for (const skill of skills) {
      expect(skill.slug).toBeTruthy();
      expect(skill.content).toBeTruthy();
      expect(skill.content.length).toBeGreaterThan(10);
    }
  });
});

describe("loadHiveSkills", () => {
  it("returns empty array when hive skills path does not exist", () => {
    const skills = loadHiveSkills("/nonexistent/path/skills");
    expect(skills).toEqual([]);
  });
});

describe("resolveSkillsForTask", () => {
  it("returns matching skills by slug list", () => {
    const allSkills = loadSystemSkills(SYSTEM_SKILLS_PATH);
    const resolved = resolveSkillsForTask(allSkills, ["blog-writing"]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toContain("blog-writing");
  });

  it("returns empty for no matches", () => {
    const allSkills = loadSystemSkills(SYSTEM_SKILLS_PATH);
    const resolved = resolveSkillsForTask(allSkills, ["nonexistent-skill"]);
    expect(resolved).toHaveLength(0);
  });

  it("caps at 3 skills", () => {
    const allSkills = loadSystemSkills(SYSTEM_SKILLS_PATH);
    const resolved = resolveSkillsForTask(allSkills, [
      "blog-writing", "xero-reconciliation", "blog-writing", "xero-reconciliation", "blog-writing",
    ]);
    expect(resolved.length).toBeLessThanOrEqual(3);
  });
});
