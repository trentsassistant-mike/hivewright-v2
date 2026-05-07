const COMPACTION_THRESHOLD = 0.7;

export function shouldCompact(currentTokens: number, maxTokens: number): boolean {
  return currentTokens >= maxTokens * COMPACTION_THRESHOLD;
}

export function buildCompactionRequest(): string {
  return [
    "## Context Compaction Required",
    "",
    "Your context is getting large. To maintain quality, summarise your work so far into a handover brief.",
    "",
    "Include in your summary:",
    "1. **Strategic decisions** you've made and why",
    "2. **Current state** — what's been completed, what's in progress, what's next",
    "3. **Key learnings** — anything important discovered during execution",
    "4. **Open questions** — anything still unresolved",
    "5. **Next steps** — your plan for the next sprint",
    "",
    "This summary will be used to seed a fresh session so you can continue with clean context.",
  ].join("\n");
}

export function buildCompactedSessionPrompt(
  originalGoalPrompt: string,
  handoverBrief: string,
): string {
  return [
    originalGoalPrompt,
    "",
    "## Handover from Previous Session",
    "",
    handoverBrief,
    "",
    "Continue from where you left off. Review the handover brief and proceed with the next sprint.",
  ].join("\n");
}
