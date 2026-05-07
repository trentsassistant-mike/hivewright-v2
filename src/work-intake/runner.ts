import type { Sql } from "postgres";
import { getChatProvider } from "@/llm";
import { loadCredentials } from "@/credentials/manager";
import { classifyWork } from "./classifier";
import { loadWorkIntakeConfig } from "./config-loader";
import { getRoleSnapshot } from "./role-snapshot";
import type { ClassifierOutcome } from "./types";

export async function runClassifier(
  sql: Sql,
  input: string,
): Promise<ClassifierOutcome> {
  const config = await loadWorkIntakeConfig(sql);

  // Load OpenRouter key if either slot uses it. Global credential: no hiveId.
  let openrouterApiKey = "";
  if (config.primaryProvider === "openrouter" || config.fallbackProvider === "openrouter") {
    const encryptionKey = process.env.ENCRYPTION_KEY || "";
    if (encryptionKey) {
      const creds = await loadCredentials(sql, {
        hiveId: "00000000-0000-0000-0000-000000000000",
        requiredKeys: ["OPENROUTER_API_KEY"],
        roleSlug: "work-intake",
        encryptionKey,
      });
      // creds is Record<string, string> due to requiredKeys override, so cast is safe
      openrouterApiKey = (creds as unknown as Record<string, string>).OPENROUTER_API_KEY ?? "";
    }
  }

  const primary = getChatProvider(config.primaryProvider, { openrouterApiKey });
  const fallback = getChatProvider(config.fallbackProvider, { openrouterApiKey });

  const roleLines = await getRoleSnapshot(sql);
  const validRoles = roleLines.map((l) => {
    const m = l.match(/^-\s+([a-z0-9-]+)\s/i);
    return m ? m[1] : "";
  }).filter(Boolean);

  return classifyWork(input, {
    primary,
    fallback,
    primaryModel: config.primaryModel,
    fallbackModel: config.fallbackModel,
    confidenceThreshold: config.confidenceThreshold,
    timeoutMs: config.timeoutMs,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    validRoles,
    roleLines,
  });
}
