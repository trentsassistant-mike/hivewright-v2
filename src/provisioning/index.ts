import type { Provisioner } from "./types";
import { ClaudeCodeProvisioner } from "./claude-code";
import { CodexProvisioner } from "./codex";
import { GeminiProvisioner } from "./gemini";
import { OpenClawProvisioner } from "./openclaw";
import { OpenAIImageProvisioner } from "./openai-image";
import { OllamaProvisioner } from "./ollama";

export function provisionerFor(adapterType: string): Provisioner | null {
  switch (adapterType) {
    case "claude-code": return new ClaudeCodeProvisioner();
    case "codex": return new CodexProvisioner();
    case "gemini": return new GeminiProvisioner();
    case "openclaw": return new OpenClawProvisioner();
    case "openai-image": return new OpenAIImageProvisioner();
    case "ollama": return new OllamaProvisioner();
    default: return null;
  }
}

export type { Provisioner, ProvisionStatus, ProvisionProgress, ProvisionerInput } from "./types";
