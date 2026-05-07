import { requireSystemOwner } from "@/app/api/_lib/auth";
import { sql } from "@/app/api/_lib/db";
import { jsonError, jsonOk } from "@/app/api/_lib/responses";
import { decrypt } from "@/credentials/encryption";
import {
  discoverModelsForAdapter,
  discoveryConfigForAdapter,
  UnsupportedDiscoveryAdapterError,
} from "@/model-discovery/providers";
import { runModelDiscoveryImport } from "@/model-discovery/service";

type CredentialRow = {
  id: string;
  hive_id: string | null;
  key: string;
  value: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }
  if (!isRecord(body)) return jsonError("JSON body must be an object", 400);

  const hiveId = stringField(body.hiveId);
  const adapterType = stringField(body.adapterType);
  const provider = nullableStringField(body.provider);
  const credentialId = nullableStringField(body.credentialId);

  if (!hiveId) return jsonError("hiveId is required", 400);
  if (!adapterType) return jsonError("adapterType is required", 400);
  if (!isUuid(hiveId)) return jsonError("hiveId must be a valid UUID", 400);
  if (credentialId && !isUuid(credentialId)) return jsonError("credentialId must be a valid UUID", 400);

  try {
    const discoveryConfig = discoveryConfigForAdapter({ adapterType, provider });
    const [hive] = await sql<{ id: string }[]>`
      SELECT id FROM hives WHERE id = ${hiveId} LIMIT 1
    `;
    if (!hive) return jsonError("hive not found", 404);

    const credentials = await loadDiscoveryCredentials({
      hiveId,
      credentialId,
      adapterType: discoveryConfig.adapterType,
    });
    if ("response" in credentials) return credentials.response;

    const models = await discoverModelsForAdapter({
      adapterType: discoveryConfig.adapterType,
      provider: discoveryConfig.provider,
      credentials: credentials.value,
    });
    const result = await runModelDiscoveryImport(sql, {
      hiveId,
      adapterType: discoveryConfig.adapterType,
      provider: discoveryConfig.provider,
      credentialId,
      source: discoveryConfig.source,
      models,
    });

    return jsonOk({
      hiveId,
      adapterType: discoveryConfig.adapterType,
      provider: discoveryConfig.provider,
      source: discoveryConfig.source,
      result,
    });
  } catch (err) {
    if (err instanceof UnsupportedDiscoveryAdapterError) {
      return jsonError(err.message, 400);
    }

    const message = err instanceof Error ? err.message : "Model discovery failed";
    console.error("[model-setup discover] failed:", err);
    return jsonError(message, 502);
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableStringField(value: unknown): string | null {
  const trimmed = stringField(value);
  return trimmed || null;
}

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

async function loadDiscoveryCredentials(input: {
  hiveId: string;
  credentialId: string | null;
  adapterType: string;
}): Promise<{ value: Record<string, string> } | { response: Response }> {
  if (!input.credentialId) return { value: {} };

  const credential = await loadCredentialById(input.credentialId);
  if (!credential) return { response: jsonError("credential not found", 404) };

  if (credential.hive_id && credential.hive_id !== input.hiveId) {
    return { response: jsonError("credential must be global or belong to the selected hive", 400) };
  }

  const allowedKeys = expectedCredentialKeysForAdapter(input.adapterType);
  if (!allowedKeys.includes(credential.key)) {
    return {
      response: jsonError(
        `credential key must be one of ${allowedKeys.join(", ")} for ${input.adapterType} discovery`,
        400,
      ),
    };
  }

  const encryptionKey = process.env.ENCRYPTION_KEY ?? "";
  if (!encryptionKey) return { response: jsonError("ENCRYPTION_KEY not configured", 500) };

  try {
    return { value: { [credential.key]: decrypt(credential.value, encryptionKey) } };
  } catch {
    return { response: jsonError("credential decrypt failed", 500) };
  }
}

async function loadCredentialById(credentialId: string): Promise<CredentialRow | null> {
  const [credential] = await sql<CredentialRow[]>`
    SELECT id, hive_id, key, value
    FROM credentials
    WHERE id = ${credentialId}
    LIMIT 1
  `;
  return credential ?? null;
}

function expectedCredentialKeysForAdapter(adapterType: string): string[] {
  if (adapterType === "codex") return ["OPENAI_API_KEY"];
  if (adapterType === "gemini") return ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"];
  if (adapterType === "claude-code") return ["ANTHROPIC_API_KEY"];
  if (adapterType === "ollama") return ["OLLAMA_ENDPOINT", "OLLAMA_BASE_URL"];
  return [];
}
