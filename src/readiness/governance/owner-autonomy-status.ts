export interface OwnerAutonomyStatusInput {
  activeGoals: number;
  activeTasks: number;
  pendingDecisions: number;
  pendingExternalActionRequests: number;
  budgetUsedCents: number;
  budgetCapCents: number;
  connectorErrors: number;
  lastEvidenceArtifact?: string | null;
  blockers: string[];
  paused: boolean;
}

export interface OwnerAutonomyStatusBrief {
  activeGoals: number;
  activeTasks: number;
  pendingDecisions: number;
  pendingExternalActionRequests: number;
  budgetUsedCents: number;
  budgetCapCents: number;
  budgetRemainingCents: number;
  budgetPercentUsed: number;
  connectorErrors: number;
  lastEvidenceArtifact: string | null;
  blockers: string[];
  paused: boolean;
  status: "paused" | "blocked" | "needs_review" | "normal";
}

export function deriveOwnerAutonomyStatus(input: OwnerAutonomyStatusInput): OwnerAutonomyStatusBrief {
  const budgetCapCents = Math.max(0, Math.trunc(input.budgetCapCents));
  const budgetUsedCents = Math.max(0, Math.trunc(input.budgetUsedCents));
  const budgetPercentUsed = budgetCapCents > 0 ? Math.min(100, Math.round((budgetUsedCents / budgetCapCents) * 100)) : 100;
  const blockers = input.blockers.filter(Boolean);
  let status: OwnerAutonomyStatusBrief["status"] = "normal";
  if (input.paused) status = "paused";
  else if (blockers.length > 0 || input.connectorErrors > 0 || budgetUsedCents >= budgetCapCents) status = "blocked";
  else if (input.pendingDecisions > 0 || input.pendingExternalActionRequests > 0) status = "needs_review";

  return {
    activeGoals: Math.max(0, Math.trunc(input.activeGoals)),
    activeTasks: Math.max(0, Math.trunc(input.activeTasks)),
    pendingDecisions: Math.max(0, Math.trunc(input.pendingDecisions)),
    pendingExternalActionRequests: Math.max(0, Math.trunc(input.pendingExternalActionRequests)),
    budgetUsedCents,
    budgetCapCents,
    budgetRemainingCents: Math.max(0, budgetCapCents - budgetUsedCents),
    budgetPercentUsed,
    connectorErrors: Math.max(0, Math.trunc(input.connectorErrors)),
    lastEvidenceArtifact: input.lastEvidenceArtifact ?? null,
    blockers,
    paused: input.paused,
    status,
  };
}
