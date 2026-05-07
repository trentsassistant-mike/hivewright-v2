import { callGenerationModel, type ModelCallerConfig, getDefaultConfig } from "../memory/model-caller";

export interface BriefValidationInput {
  title: string;
  brief: string;
  acceptanceCriteria: string | null;
  assignedTo: string;
  roleType: "system" | "executor";
}

export interface BriefValidation {
  passed: boolean;
  issues: string[];
  warnings: string[];
}

export function validateBrief(input: BriefValidationInput): BriefValidation {
  const issues: string[] = [];
  const warnings: string[] = [];

  if (input.roleType === "system") {
    return { passed: true, issues: [], warnings: [] };
  }

  if (input.brief.length < 20) {
    warnings.push("Task brief is very short (under 20 chars) — may lack sufficient context");
  }

  if (!input.acceptanceCriteria) {
    warnings.push("No acceptance criteria specified — QA review may lack clear pass/fail criteria");
  }

  return {
    passed: issues.length === 0,
    issues,
    warnings,
  };
}

export async function validateBriefWithLLM(
  input: { title: string; brief: string; acceptanceCriteria: string | null; assignedTo: string; roleType: string },
  modelConfig?: ModelCallerConfig,
): Promise<{ passed: boolean; issues: string[] }> {
  const config = modelConfig ?? getDefaultConfig();

  const prompt = `You are a task quality reviewer. Check this task brief for issues.

Title: ${input.title}
Role: ${input.assignedTo} (${input.roleType})
Brief: ${input.brief}
Acceptance Criteria: ${input.acceptanceCriteria || "None provided"}

Check for:
1. Is the brief clear enough for the assigned role to execute?
2. Are acceptance criteria verifiable (not vague)?
3. Is the scope reasonable for a single task?
4. Are there any ambiguities that could cause the agent to go in the wrong direction?

Respond with ONLY JSON:
{"passed": true|false, "issues": ["issue 1", "issue 2"]}

If everything looks good, return {"passed": true, "issues": []}`;

  try {
    const response = await callGenerationModel(prompt, config);
    let cleaned = response.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) cleaned = fenceMatch[1].trim();

    const parsed = JSON.parse(cleaned);
    return {
      passed: parsed.passed === true,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    };
  } catch {
    // If LLM call fails, pass through (don't block tasks because QA model is down)
    return { passed: true, issues: [] };
  }
}
