import { describe, it, expect } from "vitest";
import { classifyTaskTools } from "@/tools/task-classifier";

describe("classifyTaskTools (heuristic mode)", () => {
  it("returns empty list when mode is 'off'", () => {
    const out = classifyTaskTools(
      { taskBrief: "take a screenshot", taskTitle: "QA", roleSlug: "qa" },
      "off",
    );
    expect(out.mcps).toEqual([]);
  });

  it("grants the qa role the playwright baseline regardless of brief", () => {
    const out = classifyTaskTools(
      { taskBrief: "Review the deliverable for acceptance criteria", taskTitle: "QA check", roleSlug: "qa" },
      "heuristic",
    );
    expect(out.mcps).toContain("playwright");
  });

  it("grants context7 + sequential-thinking to research-analyst by default", () => {
    const out = classifyTaskTools(
      { taskBrief: "Look at recent industry trends", taskTitle: "Daily scan", roleSlug: "research-analyst" },
      "heuristic",
    );
    expect(out.mcps).toContain("context7");
    expect(out.mcps).toContain("sequential-thinking");
  });

  it("grants github when the brief mentions PR/issue/merge", () => {
    const out = classifyTaskTools(
      { taskBrief: "Open a pull request in the HiveWright repo with these fixes", taskTitle: "PR", roleSlug: "dev-agent" },
      "heuristic",
    );
    expect(out.mcps).toContain("github");
  });

  it("grants playwright when the brief mentions visual verification", () => {
    const out = classifyTaskTools(
      { taskBrief: "Visually verify the dashboard renders correctly in light mode", taskTitle: "Visual QA", roleSlug: "dev-agent" },
      "heuristic",
    );
    expect(out.mcps).toContain("playwright");
  });

  it("grants no MCPs for a minimal brief with a role that has no baseline", () => {
    const out = classifyTaskTools(
      { taskBrief: "Write the week's summary email.", taskTitle: "Summary", roleSlug: "content-writer" },
      "heuristic",
    );
    expect(out.mcps).toEqual([]);
  });

  it("dedupes when role baseline and keyword rule would both grant the same MCP", () => {
    const out = classifyTaskTools(
      { taskBrief: "Take a screenshot of the dashboard and compare", taskTitle: "QA", roleSlug: "qa" },
      "heuristic",
    );
    const pwCount = out.mcps.filter((m) => m === "playwright").length;
    expect(pwCount).toBe(1);
  });

  it("reasons array explains each grant", () => {
    const out = classifyTaskTools(
      { taskBrief: "Open a PR for the fix and take a screenshot", taskTitle: "Ship it", roleSlug: "dev-agent" },
      "heuristic",
    );
    expect(out.mcps).toEqual(expect.arrayContaining(["github", "playwright"]));
    expect(out.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it("returns mcps in a stable sorted order for deterministic output", () => {
    const out = classifyTaskTools(
      { taskBrief: "Plan multi-step, take a screenshot, then open a pr with docs for the library", taskTitle: "All", roleSlug: "qa" },
      "heuristic",
    );
    expect(out.mcps).toEqual([...out.mcps].sort());
  });
});
