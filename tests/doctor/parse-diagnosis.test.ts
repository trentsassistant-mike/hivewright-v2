import { describe, it, expect } from "vitest";
import { parseDoctorDiagnosis } from "@/doctor";

describe("parseDoctorDiagnosis", () => {
  it("extracts a diagnosis from a fenced json block", () => {
    const output = [
      "I looked at the failure.",
      "",
      "```json",
      JSON.stringify({
        action: "rewrite_brief",
        details: "Brief was ambiguous.",
        newBrief: "Use the NewBook API's /customers endpoint...",
      }),
      "```",
      "",
      "That should resolve it.",
    ].join("\n");

    const result = parseDoctorDiagnosis(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnosis.action).toBe("rewrite_brief");
      expect(result.diagnosis.newBrief).toContain("NewBook API");
    }
  });

  it("extracts the LAST fenced json block if multiple are present", () => {
    const output = [
      "First attempt at diagnosis:",
      "```json",
      JSON.stringify({ action: "rewrite_brief", details: "x", newBrief: "y" }),
      "```",
      "Actually on reflection, reassigning is better:",
      "```json",
      JSON.stringify({ action: "reassign", details: "wrong role", newRole: "data-analyst" }),
      "```",
    ].join("\n");

    const result = parseDoctorDiagnosis(output);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diagnosis.action).toBe("reassign");
  });

  it("fails when no fenced json block exists", () => {
    const result = parseDoctorDiagnosis("I think we should rewrite the brief.");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/no.*json.*block/i);
  });

  it("fails when the fenced block contains invalid JSON", () => {
    const output = "```json\n{action: not-quoted}\n```";
    const result = parseDoctorDiagnosis(output);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/malformed/i);
  });

  it("fails when action is not one of the 5 allowed values", () => {
    const output = "```json\n" + JSON.stringify({ action: "nuke_it", details: "x" }) + "\n```";
    const result = parseDoctorDiagnosis(output);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/unknown action/i);
  });

  it("fails when reassign is missing newRole", () => {
    const output = "```json\n" + JSON.stringify({ action: "reassign", details: "wrong role" }) + "\n```";
    const result = parseDoctorDiagnosis(output);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/newRole/);
  });

  it("fails when rewrite_brief is missing newBrief", () => {
    const output = "```json\n" + JSON.stringify({ action: "rewrite_brief", details: "x" }) + "\n```";
    const result = parseDoctorDiagnosis(output);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/newBrief/);
  });

  it("fails when split_task is missing subTasks or subTasks is empty", () => {
    const noSubTasks = "```json\n" + JSON.stringify({ action: "split_task", details: "x" }) + "\n```";
    const emptySubTasks = "```json\n" + JSON.stringify({ action: "split_task", details: "x", subTasks: [] }) + "\n```";
    expect(parseDoctorDiagnosis(noSubTasks).ok).toBe(false);
    expect(parseDoctorDiagnosis(emptySubTasks).ok).toBe(false);
  });

  it("accepts escalate with only details (no extra fields required)", () => {
    const output = "```json\n" + JSON.stringify({ action: "escalate", details: "Owner input needed." }) + "\n```";
    const result = parseDoctorDiagnosis(output);
    expect(result.ok).toBe(true);
  });

  it("accepts fix_environment with only details", () => {
    const output = "```json\n" + JSON.stringify({ action: "fix_environment", details: "API key missing for NewBook." }) + "\n```";
    const result = parseDoctorDiagnosis(output);
    expect(result.ok).toBe(true);
  });

  it("fails when action is missing entirely", () => {
    const output = "```json\n" + JSON.stringify({ details: "something" }) + "\n```";
    const result = parseDoctorDiagnosis(output);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/action/i);
  });

  it("fails when details is missing (required for all actions)", () => {
    const output = "```json\n" + JSON.stringify({ action: "escalate" }) + "\n```";
    const result = parseDoctorDiagnosis(output);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/details/i);
  });

  it("accepts uppercase ```JSON fence (LLMs sometimes capitalise)", () => {
    const output = "```JSON\n" +
      JSON.stringify({ action: "escalate", details: "case-variant fence" }) +
      "\n```";
    const result = parseDoctorDiagnosis(output);
    expect(result.ok).toBe(true);
  });

  it("fails when split_task subTasks entries have wrong field types", () => {
    const output = "```json\n" + JSON.stringify({
      action: "split_task",
      details: "x",
      subTasks: [{ title: 42, brief: "y", assignedTo: "r" }],
    }) + "\n```";
    const result = parseDoctorDiagnosis(output);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/subTasks.*title.*brief.*assignedTo/);
  });

  it("fails when decisionTitle is present but not a string", () => {
    const output = "```json\n" + JSON.stringify({
      action: "escalate",
      details: "x",
      decisionTitle: 42,
    }) + "\n```";
    const result = parseDoctorDiagnosis(output);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/decisionTitle/);
  });

  it("fails when decisionContext is present but not a string", () => {
    const output = "```json\n" + JSON.stringify({
      action: "escalate",
      details: "x",
      decisionContext: { nested: "object" },
    }) + "\n```";
    const result = parseDoctorDiagnosis(output);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/decisionContext/);
  });
});
