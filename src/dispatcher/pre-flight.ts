import fs from "fs";
import type { SessionContext } from "../adapters/types";
import { getProviderEndpoint } from "../adapters/provider-config";
import { getOpenAIImagesApiAuthStatus } from "../adapters/openai-auth";

export interface PreFlightResult {
  passed: boolean;
  failures: string[];
}

async function checkOllamaHealth(model: string): Promise<string | null> {
  const endpoint = getProviderEndpoint("ollama");
  if (!endpoint) return "Ollama endpoint is not configured";

  try {
    const tagsRes = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!tagsRes.ok) {
      return `Ollama health check failed: ${tagsRes.status} ${tagsRes.statusText}`;
    }

    const tags = await tagsRes.json() as { models?: { name?: string; model?: string }[] };
    const modelName = model.startsWith("ollama/") ? model.slice(7) : model;
    const available = (tags.models ?? []).some((m) => m.name === modelName || m.model === modelName);

    if (!available) {
      return `Ollama model not available: ${modelName}`;
    }

    return null;
  } catch (err) {
    if (err instanceof Error) {
      return `Cannot reach Ollama at ${endpoint}: ${err.message}`;
    }
    return `Cannot reach Ollama at ${endpoint}`;
  }
}

export async function runPreFlightChecks(ctx: SessionContext): Promise<PreFlightResult> {
  const failures: string[] = [];
  const isOpenAIImage = ctx.primaryAdapterType === "openai-image" || ctx.roleTemplate.slug === "image-designer";

  if (ctx.projectWorkspace && !fs.existsSync(ctx.projectWorkspace)) {
    failures.push(`Project workspace does not exist: ${ctx.projectWorkspace}`);
  }

  if (!ctx.model) {
    failures.push("No model specified for task execution");
  }

  if (ctx.roleTemplate.toolsMd) {
    const match = ctx.roleTemplate.toolsMd.match(/requires:\s*\[([^\]]+)\]/i);
    if (match) {
      const required = match[1].split(",").map((s) => s.trim()).filter(Boolean);
      for (const key of required) {
        if (!ctx.credentials[key] && !process.env[key]) {
          if (isOpenAIImage) {
            failures.push(`Missing required openai-image credential: ${key}`);
          } else {
            failures.push(`Missing required credential: ${key}`);
          }
        }
      }
    }
  }

  if (ctx.model?.startsWith("ollama/")) {
    const ollamaFailure = await checkOllamaHealth(ctx.model);
    if (ollamaFailure) failures.push(ollamaFailure);
  }

  if (isOpenAIImage && !failures.some((failure) => failure.includes("OpenAI Images API auth"))) {
    const status = getOpenAIImagesApiAuthStatus(ctx.credentials);
    if (!status.available) {
      failures.push(`Missing required OpenAI Images API auth: OPENAI_API_KEY is required. ${status.reason ?? status.label}`);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}
