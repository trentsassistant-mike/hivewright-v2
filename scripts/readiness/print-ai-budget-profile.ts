import { DEFAULT_REAL_BUSINESS_AI_BUDGET_PROFILE, renderAiBudgetProfile, validateAiBudgetProfile } from "@/readiness/governance/ai-budget-profile";
const errors = validateAiBudgetProfile(DEFAULT_REAL_BUSINESS_AI_BUDGET_PROFILE);
console.log(renderAiBudgetProfile(DEFAULT_REAL_BUSINESS_AI_BUDGET_PROFILE));
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
}
