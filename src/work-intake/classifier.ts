import type { ChatProvider } from "@/llm/types";
import type { ClassifierAttempt, ClassifierOutcome, ClassifierResult } from "./types";
import { buildClassifierPrompt, buildClassifierUserMessage } from "./prompt";
import { extractFirstJsonBlock, isValidClassifierResult } from "./type-guard";

export interface ClassifyDeps {
  primary: ChatProvider | null;
  fallback: ChatProvider | null;
  primaryModel: string;
  fallbackModel: string;
  confidenceThreshold: number;
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
  validRoles: string[];
  roleLines: string[];
}

export async function classifyWork(input: string, deps: ClassifyDeps): Promise<ClassifierOutcome> {
  const { system } = buildClassifierPrompt(deps.roleLines);
  const user = buildClassifierUserMessage(input);

  const attempts: ClassifierAttempt[] = [];
  let fallbackTried = false;

  if (deps.primary) {
    const attempt = await tryProvider(
      deps.primary, deps.primaryModel, system, user, input,
      deps.timeoutMs, deps.temperature, deps.maxTokens,
      deps.confidenceThreshold, deps.validRoles,
    );
    attempts.push(attempt);
    if (attempt.success && attempt.parsedResult) {
      return {
        result: attempt.parsedResult,
        attempts,
        usedFallback: false,
        providerUsed: deps.primary.id === "ollama" ? "ollama" : "openrouter",
        modelUsed: attempt.model,
      };
    }
  }

  if (deps.fallback) {
    fallbackTried = true;
    const attempt = await tryProvider(
      deps.fallback, deps.fallbackModel, system, user, input,
      deps.timeoutMs, deps.temperature, deps.maxTokens,
      deps.confidenceThreshold, deps.validRoles,
    );
    attempts.push(attempt);
    if (attempt.success && attempt.parsedResult) {
      return {
        result: attempt.parsedResult,
        attempts,
        usedFallback: true,
        providerUsed: deps.fallback.id === "ollama" ? "ollama" : "openrouter",
        modelUsed: attempt.model,
      };
    }
  }

  return {
    result: null,
    attempts,
    usedFallback: fallbackTried,
    providerUsed: "default-goal-fallback",
    modelUsed: null,
  };
}

interface ProviderAttempt extends ClassifierAttempt {
  parsedResult: ClassifierResult | null;
}

async function tryProvider(
  provider: ChatProvider,
  model: string,
  system: string,
  user: string,
  rawInput: string,
  timeoutMs: number,
  temperature: number,
  maxTokens: number,
  confidenceThreshold: number,
  validRoles: string[],
): Promise<ProviderAttempt> {
  const startedAt = Date.now();
  const base = {
    provider: provider.id,
    model,
    prompt: `${system}\n\n${user}`,
    input: rawInput,
    tokensIn: null as number | null,
    tokensOut: null as number | null,
    costCents: null as number | null,
  };

  try {
    const resp = await provider.chat({
      system, user, model, temperature, maxTokens, timeoutMs,
    });
    const latencyMs = Date.now() - startedAt;

    const jsonText = extractFirstJsonBlock(resp.text);
    if (!jsonText) {
      return {
        ...base,
        latencyMs,
        tokensIn: resp.tokensIn,
        tokensOut: resp.tokensOut,
        responseRaw: resp.text,
        success: false,
        errorReason: "no JSON object found in model response",
        parsedResult: null,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      return {
        ...base,
        latencyMs,
        tokensIn: resp.tokensIn,
        tokensOut: resp.tokensOut,
        responseRaw: resp.text,
        success: false,
        errorReason: `JSON parse failed: ${(err as Error).message}`,
        parsedResult: null,
      };
    }

    if (!isValidClassifierResult(parsed)) {
      return {
        ...base,
        latencyMs,
        tokensIn: resp.tokensIn,
        tokensOut: resp.tokensOut,
        responseRaw: resp.text,
        success: false,
        errorReason: "JSON did not match ClassifierResult schema",
        parsedResult: null,
      };
    }

    if (parsed.type === "task" && !validRoles.includes(parsed.role)) {
      return {
        ...base,
        latencyMs,
        tokensIn: resp.tokensIn,
        tokensOut: resp.tokensOut,
        responseRaw: resp.text,
        success: false,
        errorReason: `role '${parsed.role}' is not in the valid role library`,
        parsedResult: null,
      };
    }

    if (parsed.confidence < confidenceThreshold) {
      return {
        ...base,
        latencyMs,
        tokensIn: resp.tokensIn,
        tokensOut: resp.tokensOut,
        responseRaw: resp.text,
        success: false,
        errorReason: `confidence ${parsed.confidence} below threshold ${confidenceThreshold}`,
        parsedResult: null,
      };
    }

    return {
      ...base,
      latencyMs,
      tokensIn: resp.tokensIn,
      tokensOut: resp.tokensOut,
      responseRaw: resp.text,
      success: true,
      errorReason: null,
      parsedResult: parsed,
    };
  } catch (err) {
    return {
      ...base,
      latencyMs: Date.now() - startedAt,
      responseRaw: null,
      success: false,
      errorReason: (err as Error).message,
      parsedResult: null,
    };
  }
}
