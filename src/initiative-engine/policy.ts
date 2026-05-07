import { classifySensitivity } from "@/work-products/sensitivity";

export type InitiativePolicySensitivity = "public" | "internal" | "confidential" | "restricted";
export type InitiativePolicyDecision = "allow" | "suppress";
export type InitiativePolicyBlockReason = "policy_blocked_sensitivity";
export type InitiativePolicyEscalationPath = "owner_review_required";

export interface InitiativeCreationPolicyInput {
  input: string;
  acceptanceCriteria: string;
}

export interface InitiativeCreationPolicyResult {
  allowed: boolean;
  decision: InitiativePolicyDecision;
  sensitivity: InitiativePolicySensitivity;
  reason: InitiativePolicyBlockReason | null;
  rationale: string;
  escalationPath: InitiativePolicyEscalationPath | null;
  policy: {
    allowedSensitivityLevels: InitiativePolicySensitivity[];
  };
}

export const INITIATIVE_CREATION_POLICY = {
  allowedSensitivityLevels: ["public", "internal"] as InitiativePolicySensitivity[],
  deniedDecision: "suppress" as const,
  deniedEscalationPath: "owner_review_required" as const,
};

export async function evaluateInitiativeCreationPolicy(
  input: InitiativeCreationPolicyInput,
): Promise<InitiativeCreationPolicyResult> {
  const sensitivity = classifySensitivity(
    [input.input, input.acceptanceCriteria].filter(Boolean).join("\n\n"),
  );

  const base = {
    sensitivity,
    policy: {
      allowedSensitivityLevels: INITIATIVE_CREATION_POLICY.allowedSensitivityLevels,
    },
  };

  if (!INITIATIVE_CREATION_POLICY.allowedSensitivityLevels.includes(sensitivity)) {
    return {
      ...base,
      allowed: false,
      decision: INITIATIVE_CREATION_POLICY.deniedDecision,
      reason: "policy_blocked_sensitivity",
      rationale:
        `Autonomous initiative creation is limited to ${INITIATIVE_CREATION_POLICY.allowedSensitivityLevels.join(", ")} ` +
        `content, but this request classified as ${sensitivity}.`,
      escalationPath: INITIATIVE_CREATION_POLICY.deniedEscalationPath,
    };
  }

  return {
    ...base,
    allowed: true,
    decision: "allow",
    reason: null,
    rationale: `Autonomous initiative creation is permitted for ${sensitivity} content.`,
    escalationPath: null,
  };
}
