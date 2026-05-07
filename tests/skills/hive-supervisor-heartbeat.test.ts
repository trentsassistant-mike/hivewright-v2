import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { loadSystemSkills } from "@/skills/loader";

const skillPath = path.resolve(
  __dirname,
  "../../skills-library/hive-supervisor-heartbeat/SKILL.md",
);

describe("hive-supervisor-heartbeat skill", () => {
  it("loads as a system skill", () => {
    const skills = loadSystemSkills(path.resolve(__dirname, "../../skills-library"));
    const skill = skills.find((s) => s.slug === "hive-supervisor-heartbeat");

    expect(skill).toBeDefined();
    expect(skill?.content).toContain("# Hive Supervisor Heartbeat Gates");
  });

  it("encodes the four mandatory gates in order", () => {
    const content = fs.readFileSync(skillPath, "utf-8");
    const headings = [
      "### 1. Stderr Scan",
      "### 2. Standing Instructions Check",
      "### 3. Lightest-Touch Action First",
      "### 4. Non-Truncated Output",
    ];
    const positions = headings.map((heading) => content.indexOf(heading));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("requires thread-not-found stderr to route through create_decision before spawn_followup", () => {
    const content = fs.readFileSync(skillPath, "utf-8");
    const stderrGate = content.slice(
      content.indexOf("### 1. Stderr Scan"),
      content.indexOf("### 2. Standing Instructions Check"),
    );

    expect(stderrGate).toContain("thread not found");
    expect(stderrGate).toContain("failed to record rollout items");
    expect(stderrGate).toContain("emit a `create_decision` action");
    expect(stderrGate).toContain("do not proceed to `spawn_followup`");
  });
});
