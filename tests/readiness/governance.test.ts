import { describe, expect, it } from "vitest";
import { DEFAULT_REAL_BUSINESS_AI_BUDGET_PROFILE, renderAiBudgetProfile, validateAiBudgetProfile } from "@/readiness/governance/ai-budget-profile";
import { EMERGENCY_STOP_MARKDOWN, EMERGENCY_STOP_STEPS } from "@/readiness/governance/emergency-stop";
import { deriveOwnerAutonomyStatus } from "@/readiness/governance/owner-autonomy-status";

describe("controlled-autonomy governance readiness", () => {
  it("ships a conservative valid budget profile", () => {
    expect(validateAiBudgetProfile(DEFAULT_REAL_BUSINESS_AI_BUDGET_PROFILE)).toEqual([]);
    expect(DEFAULT_REAL_BUSINESS_AI_BUDGET_PROFILE.maxConcurrentAgents).toBeLessThanOrEqual(2);
    expect(DEFAULT_REAL_BUSINESS_AI_BUDGET_PROFILE.externalSends).toBe("approval_required");
    expect(DEFAULT_REAL_BUSINESS_AI_BUDGET_PROFILE.financialActions).toBe("blocked");
    expect(renderAiBudgetProfile()).toContain("Stop conditions");
  });

  it("rejects unsafe AI budget profiles", () => {
    const unsafe = {
      ...DEFAULT_REAL_BUSINESS_AI_BUDGET_PROFILE,
      perTaskCapCents: 2_000,
      financialActions: "approval_required" as const,
      maxConcurrentAgents: 5,
    };
    expect(validateAiBudgetProfile(unsafe)).toEqual(expect.arrayContaining([
      "perTaskCapCents must not exceed perGoalCapCents",
      "maxConcurrentAgents must be 1 or 2 for real-business controlled autonomy mode",
      "financialActions must default to blocked for controlled real-business autonomy",
    ]));
  });

  it("defines kill switch steps that include pause, schedules, pending actions, connectors, and budget", () => {
    for (const phrase of ["Pause the hive", "Disable schedules", "pending external action", "connector", "budget"]) {
      expect(EMERGENCY_STOP_MARKDOWN.toLowerCase()).toContain(phrase.toLowerCase());
    }
    expect(EMERGENCY_STOP_STEPS.length).toBeGreaterThanOrEqual(6);
  });

  it("derives owner-facing status from controlled-autonomy counters", () => {
    expect(deriveOwnerAutonomyStatus({
      activeGoals: 1,
      activeTasks: 2,
      pendingDecisions: 1,
      pendingExternalActionRequests: 0,
      budgetUsedCents: 200,
      budgetCapCents: 1_000,
      connectorErrors: 0,
      blockers: [],
      paused: false,
    }).status).toBe("needs_review");
    expect(deriveOwnerAutonomyStatus({
      activeGoals: 0,
      activeTasks: 0,
      pendingDecisions: 0,
      pendingExternalActionRequests: 0,
      budgetUsedCents: 1_000,
      budgetCapCents: 1_000,
      connectorErrors: 0,
      blockers: [],
      paused: false,
    }).status).toBe("blocked");
  });
});
