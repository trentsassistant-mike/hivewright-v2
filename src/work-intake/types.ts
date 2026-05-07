import type { ProviderId } from "@/llm/types";

export type ClassifierResult =
  | { type: "task"; role: string; confidence: number; reasoning: string }
  | { type: "goal"; confidence: number; reasoning: string }
  | null;

export interface ClassifierAttempt {
  provider: ProviderId | "default-goal-fallback";
  model: string | null;
  prompt: string;
  input: string;
  responseRaw: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costCents: number | null;
  latencyMs: number;
  success: boolean;
  errorReason: string | null;
}

export interface ClassifierOutcome {
  result: ClassifierResult;
  attempts: ClassifierAttempt[];
  usedFallback: boolean;
  providerUsed: "ollama" | "openrouter" | "default-goal-fallback";
  modelUsed: string | null;
}

export interface WorkIntakeConfig {
  primaryProvider: "ollama" | "openrouter" | "none";
  primaryModel: string;
  fallbackProvider: "ollama" | "openrouter" | "none";
  fallbackModel: string;
  confidenceThreshold: number;
  timeoutMs: number;
  temperature: number;
  maxTokens: number;
}

export const DEFAULT_WORK_INTAKE_CONFIG: WorkIntakeConfig = {
  primaryProvider: "ollama",
  primaryModel: "qwen3:32b",
  fallbackProvider: "openrouter",
  fallbackModel: "google/gemini-2.0-flash-exp:free",
  confidenceThreshold: 0.60,
  timeoutMs: 15000,
  temperature: 0.1,
  maxTokens: 512,
};
