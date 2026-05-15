export interface AiBudgetProfile {
  name: string;
  currency: "USD";
  dailyCapCents: number;
  perGoalCapCents: number;
  perTaskCapCents: number;
  maxRetriesPerTask: number;
  maxDoctorAttempts: number;
  maxConcurrentAgents: number;
  externalSends: "approval_required" | "blocked";
  financialActions: "approval_required" | "blocked";
  destructiveActions: "blocked";
  recoveryMode: "conservative";
  stopConditions: string[];
}

export const DEFAULT_REAL_BUSINESS_AI_BUDGET_PROFILE: AiBudgetProfile = {
  name: "real-business-controlled-autonomy",
  currency: "USD",
  dailyCapCents: 1_500,
  perGoalCapCents: 750,
  perTaskCapCents: 250,
  maxRetriesPerTask: 1,
  maxDoctorAttempts: 1,
  maxConcurrentAgents: 1,
  externalSends: "approval_required",
  financialActions: "blocked",
  destructiveActions: "blocked",
  recoveryMode: "conservative",
  stopConditions: [
    "daily AI spend cap reached",
    "unapproved external side effect attempted",
    "security preflight fails",
    "owner approval is missing for customer-facing action",
    "connector returns repeated authorization errors",
  ],
};

export function validateAiBudgetProfile(profile: AiBudgetProfile): string[] {
  const errors: string[] = [];
  const positiveFields: Array<keyof Pick<AiBudgetProfile, "dailyCapCents" | "perGoalCapCents" | "perTaskCapCents">> = [
    "dailyCapCents",
    "perGoalCapCents",
    "perTaskCapCents",
  ];
  for (const field of positiveFields) {
    if (!Number.isInteger(profile[field]) || profile[field] <= 0) {
      errors.push(`${field} must be a positive integer number of cents`);
    }
  }
  if (profile.perTaskCapCents > profile.perGoalCapCents) {
    errors.push("perTaskCapCents must not exceed perGoalCapCents");
  }
  if (profile.perGoalCapCents > profile.dailyCapCents) {
    errors.push("perGoalCapCents must not exceed dailyCapCents");
  }
  if (!Number.isInteger(profile.maxConcurrentAgents) || profile.maxConcurrentAgents < 1 || profile.maxConcurrentAgents > 2) {
    errors.push("maxConcurrentAgents must be 1 or 2 for real-business controlled autonomy mode");
  }
  if (profile.financialActions !== "blocked") {
    errors.push("financialActions must default to blocked for controlled real-business autonomy");
  }
  if (profile.destructiveActions !== "blocked") {
    errors.push("destructiveActions must be blocked");
  }
  if (profile.stopConditions.length === 0) {
    errors.push("at least one stop condition is required");
  }
  return errors;
}

export function renderAiBudgetProfile(profile = DEFAULT_REAL_BUSINESS_AI_BUDGET_PROFILE): string {
  return [
    `# AI Spend Budget Profile: ${profile.name}`,
    "",
    `- Daily cap: ${profile.currency} ${(profile.dailyCapCents / 100).toFixed(2)}`,
    `- Per-goal cap: ${profile.currency} ${(profile.perGoalCapCents / 100).toFixed(2)}`,
    `- Per-task cap: ${profile.currency} ${(profile.perTaskCapCents / 100).toFixed(2)}`,
    `- Max retries per task: ${profile.maxRetriesPerTask}`,
    `- Max doctor attempts: ${profile.maxDoctorAttempts}`,
    `- Max concurrent agents: ${profile.maxConcurrentAgents}`,
    `- External sends: ${profile.externalSends}`,
    `- Financial actions: ${profile.financialActions}`,
    `- Destructive actions: ${profile.destructiveActions}`,
    `- Recovery mode: ${profile.recoveryMode}`,
    "",
    "## Stop conditions",
    ...profile.stopConditions.map((condition) => `- ${condition}`),
  ].join("\n");
}
