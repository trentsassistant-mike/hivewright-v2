import { describe, expect, it } from "vitest";
import {
  evaluateInitiativeCreationPolicy,
  INITIATIVE_CREATION_POLICY,
} from "@/initiative-engine/policy";

describe("evaluateInitiativeCreationPolicy", () => {
  it("allows autonomous creation for approved public/internal work", async () => {
    const result = await evaluateInitiativeCreationPolicy({
      input: "Inspect the dormant goal and produce the narrowest next engineering task.",
      acceptanceCriteria: "Create one executable next task with a concrete outcome.",
    });

    expect(result).toMatchObject({
      allowed: true,
      decision: "allow",
      reason: null,
      escalationPath: null,
      sensitivity: "internal",
      policy: {
        allowedSensitivityLevels: INITIATIVE_CREATION_POLICY.allowedSensitivityLevels,
      },
    });
    expect(result.rationale).toMatch(/permitted for internal content/i);
  });

  it("suppresses and escalates autonomous creation when the content is too sensitive", async () => {
    const result = await evaluateInitiativeCreationPolicy({
      input: "Investigate the leaked credential. password: supersecret123",
      acceptanceCriteria: "Contain the incident without exposing credentials.",
    });

    expect(result).toMatchObject({
      allowed: false,
      decision: "suppress",
      reason: "policy_blocked_sensitivity",
      escalationPath: "owner_review_required",
      sensitivity: "restricted",
      policy: {
        allowedSensitivityLevels: INITIATIVE_CREATION_POLICY.allowedSensitivityLevels,
      },
    });
    expect(result.rationale).toMatch(/limited to public, internal content/i);
  });
});
