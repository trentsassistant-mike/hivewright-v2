import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type OpenAIAuthSource = "api-key" | "codex-chatgpt-oauth";

export interface ResolvedOpenAIAuth {
  source: OpenAIAuthSource;
  bearerToken: string;
  label: string;
}

export interface OpenAIAuthStatus {
  available: boolean;
  source: OpenAIAuthSource | null;
  label: string;
  reason?: string;
}

interface CodexAuthFile {
  auth_mode?: unknown;
  tokens?: {
    access_token?: unknown;
    account_id?: unknown;
  };
}

const DEFAULT_CODEX_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");

export function resolveOpenAIAuth(
  credentials: Record<string, string | undefined> = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOpenAIAuth | null {
  const apiKey = credentials.OPENAI_API_KEY ?? env.OPENAI_API_KEY;
  if (apiKey) {
    return {
      source: "api-key",
      bearerToken: apiKey,
      label: "OPENAI_API_KEY",
    };
  }

  return null;
}

export function getOpenAIAuthStatus(
  credentials: Record<string, string | undefined> = {},
  env: NodeJS.ProcessEnv = process.env,
): OpenAIAuthStatus {
  const apiKey = credentials.OPENAI_API_KEY ?? env.OPENAI_API_KEY;
  if (apiKey) {
    return {
      available: true,
      source: "api-key",
      label: "OPENAI_API_KEY",
    };
  }

  const codex = readCodexOpenAIAuth(env);
  if (codex.available) {
    return {
      available: false,
      source: "codex-chatgpt-oauth",
      label: codex.label,
      reason: [
        `Codex ChatGPT auth is present at ${codex.label}, but it is not a public Images API credential.`,
        "Live proof rejected this bearer path with missing scope api.model.images.request.",
        "Codex built-in image_gen is only exposed as an internal Codex tool, not as a direct HiveWright adapter interface.",
      ].join(" "),
    };
  }

  return {
    available: false,
    source: null,
    label: codex.label,
    reason: codex.reason,
  };
}

export function getOpenAIImagesApiAuthStatus(
  credentials: Record<string, string | undefined> = {},
  env: NodeJS.ProcessEnv = process.env,
): OpenAIAuthStatus {
  const apiKey = credentials.OPENAI_API_KEY ?? env.OPENAI_API_KEY;
  if (apiKey) {
    return {
      available: true,
      source: "api-key",
      label: "OPENAI_API_KEY",
    };
  }

  const codex = readCodexOpenAIAuth(env);
  if (codex.available) {
    return {
      available: false,
      source: "codex-chatgpt-oauth",
      label: codex.label,
      reason: [
        "Codex ChatGPT auth is present, but OpenAI does not expose a supported direct Images API route for that subscription token.",
        "Live proof rejected this bearer path with missing scope api.model.images.request.",
        "Codex image generation is available only through the built-in Codex imagegen tool/session path.",
      ].join(" "),
    };
  }

  return {
    available: false,
    source: null,
    label: codex.label,
    reason: codex.reason,
  };
}

export function getCodexImageRuntimeAuthStatus(
  env: NodeJS.ProcessEnv = process.env,
): OpenAIAuthStatus {
  const codex = readCodexOpenAIAuth(env);
  if (codex.available) {
    return {
      available: true,
      source: "codex-chatgpt-oauth",
      label: codex.label,
      reason: "Codex ChatGPT auth is present for guarded Codex CLI image generation.",
    };
  }

  return {
    available: false,
    source: null,
    label: codex.label,
    reason: codex.reason,
  };
}

export function sanitizeProviderText(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[redacted-jwt]");
}

function codexAuthPath(env: NodeJS.ProcessEnv): string {
  return env.CODEX_AUTH_FILE || DEFAULT_CODEX_AUTH_PATH;
}

function readCodexOpenAIAuth(env: NodeJS.ProcessEnv): {
  available: boolean;
  bearerToken?: string;
  label: string;
  reason?: string;
} {
  const authPath = codexAuthPath(env);
  const label = authPath === DEFAULT_CODEX_AUTH_PATH ? "~/.codex/auth.json" : "CODEX_AUTH_FILE";
  try {
    const raw = fs.readFileSync(authPath, "utf-8");
    const parsed = JSON.parse(raw) as CodexAuthFile;
    if (parsed.auth_mode !== "chatgpt") {
      return {
        available: false,
        label,
        reason: `Codex auth file exists but auth_mode is not chatgpt (${label}).`,
      };
    }
    if (typeof parsed.tokens?.access_token !== "string" || parsed.tokens.access_token.length === 0) {
      return {
        available: false,
        label,
        reason: `Codex auth file is missing an access token (${label}).`,
      };
    }
    return {
      available: true,
      bearerToken: parsed.tokens.access_token,
      label,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        available: false,
        label,
        reason: `Codex auth file was not found (${label}).`,
      };
    }
    if (err instanceof SyntaxError) {
      return {
        available: false,
        label,
        reason: `Codex auth file is not valid JSON (${label}).`,
      };
    }
    return {
      available: false,
      label,
      reason: `Codex auth file could not be read (${label}).`,
    };
  }
}
