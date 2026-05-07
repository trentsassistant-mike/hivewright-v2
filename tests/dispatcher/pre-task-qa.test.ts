import { describe, it, expect } from "vitest";
import { validateBrief } from "@/dispatcher/pre-task-qa";

describe("validateBrief", () => {
  it("passes a well-formed brief", () => {
    const result = validateBrief({
      title: "Build login page",
      brief: "Create a login page with email and password fields. Use the existing auth service.",
      acceptanceCriteria: "Login form renders. User can submit credentials. Error states shown.",
      assignedTo: "dev-agent",
      roleType: "executor",
    });
    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("flags missing acceptance criteria for executor tasks", () => {
    const result = validateBrief({
      title: "Build login page",
      brief: "Create a login page with email and password form fields for authentication",
      acceptanceCriteria: null,
      assignedTo: "dev-agent",
      roleType: "executor",
    });
    expect(result.passed).toBe(true);
    expect(result.warnings.some((w) => w.includes("acceptance criteria"))).toBe(true);
  });

  it("flags very short briefs", () => {
    const result = validateBrief({
      title: "Do thing",
      brief: "Do it",
      acceptanceCriteria: null,
      assignedTo: "dev-agent",
      roleType: "executor",
    });
    expect(result.warnings.some((w) => w.includes("short"))).toBe(true);
  });

  it("skips validation for system roles", () => {
    const result = validateBrief({
      title: "Diagnose failure",
      brief: "Fix it",
      acceptanceCriteria: null,
      assignedTo: "doctor",
      roleType: "system",
    });
    expect(result.passed).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
