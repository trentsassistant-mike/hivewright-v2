import { canAccessHive } from "@/auth/users";
import {
  canonicalModelIdForAdapter,
  collapseConfiguredModelAliasRows,
} from "@/model-health/model-identity";
import {
  classifyProbeFreshness,
  getModelHealthProbePolicy,
} from "@/model-health/probe-policy";
import { createRuntimeCredentialFingerprint } from "@/model-health/probe-runner";
import { loadModelHealthByIdentity } from "@/model-health/stored-health";
import { requireApiUser } from "../_lib/auth";
import { sql } from "../_lib/db";
import { jsonError, jsonOk, parseSearchParams } from "../_lib/responses";

type HiveModelRow = {
  id: string;
  hive_id: string;
  provider: string;
  model_id: string;
  adapter_type: string;
  credential_id: string | null;
  credential_name: string | null;
  credential_fingerprint: string | null;
  capabilities: string[];
  fallback_priority: number;
  enabled: boolean;
  cost_per_input_token: string | null;
  cost_per_output_token: string | null;
};

async function requireHiveAccess(
  user: { id: string; isSystemOwner: boolean },
  hiveId: string,
) {
  if (user.isSystemOwner) return null;
  const hasAccess = await canAccessHive(sql, user.id, hiveId);
  return hasAccess ? null : jsonError("Forbidden: hive access required", 403);
}

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const params = parseSearchParams(request.url);
  const hiveId = params.get("hiveId");
  if (!hiveId) return jsonError("hiveId is required", 400);
  const limit = params.getInt("limit", 100, { min: 1, max: 200 });

  const denied = await requireHiveAccess(authz.user, hiveId);
  if (denied) return denied;

  try {
    const modelRows = await sql<HiveModelRow[]>`
      SELECT
        hm.id,
        hm.hive_id,
        hm.provider,
        hm.model_id,
        hm.adapter_type,
        hm.credential_id,
        c.name AS credential_name,
        c.fingerprint AS credential_fingerprint,
        hm.capabilities,
        hm.fallback_priority,
        hm.enabled,
        hm.cost_per_input_token,
        hm.cost_per_output_token
      FROM hive_models hm
      LEFT JOIN credentials c ON c.id = hm.credential_id
      WHERE hm.hive_id = ${hiveId}
        AND hm.enabled = true
      ORDER BY hm.fallback_priority ASC, hm.created_at ASC
      LIMIT ${limit}
    `;

    const rows = [];
    for (const row of collapseConfiguredModelAliasRows(modelRows)) {
      const healthFingerprint = row.credential_fingerprint ?? createRuntimeCredentialFingerprint({
        provider: row.provider,
        adapterType: row.adapter_type,
        baseUrl: null,
      });
      const health = await loadModelHealthByIdentity(sql, {
        fingerprint: healthFingerprint,
        adapterType: row.adapter_type,
        modelId: row.model_id,
      });
      const failure = parseFailureReason(health?.last_failure_reason ?? null);
      const probeMode = getModelHealthProbePolicy({
        provider: row.provider,
        adapterType: row.adapter_type,
        modelId: canonicalModelIdForAdapter(row.adapter_type, row.model_id),
        capabilities: row.capabilities ?? [],
        sampleCostUsd: asNullableNumber(health?.sample_cost_usd),
      }).mode;

      rows.push({
        id: row.id,
        hiveId: row.hive_id,
        provider: row.provider,
        modelId: row.model_id,
        adapterType: row.adapter_type,
        credentialId: row.credential_id,
        credentialName: row.credential_name,
        credentialFingerprint: row.credential_fingerprint,
        healthFingerprint,
        capabilities: row.capabilities ?? [],
        fallbackPriority: row.fallback_priority,
        enabled: row.enabled,
        costPerInputToken: row.cost_per_input_token,
        costPerOutputToken: row.cost_per_output_token,
        status: health?.status ?? "unknown",
        lastProbedAt: health?.last_probed_at ?? null,
        lastFailedAt: health?.last_failed_at ?? null,
        lastFailureReason: health?.last_failure_reason ?? null,
        failureClass: failure.failureClass,
        failureMessage: failure.message,
        nextProbeAt: health?.next_probe_at ?? null,
        freshness: classifyProbeFreshness(health?.next_probe_at ?? null, new Date()),
        probeMode,
        latencyMs: health?.latency_ms ?? null,
        sampleCostUsd: health?.sample_cost_usd ?? null,
      });
    }

    return jsonOk({ hiveId, limit, rows });
  } catch (err) {
    console.error("[model-health GET] failed:", err);
    return jsonError("Failed to fetch model health", 500);
  }
}

function parseFailureReason(value: string | null): {
  failureClass: string | null;
  message: string | null;
} {
  if (!value) return { failureClass: null, message: null };
  try {
    const parsed = JSON.parse(value) as { failureClass?: unknown; message?: unknown };
    return {
      failureClass: typeof parsed.failureClass === "string" ? parsed.failureClass : null,
      message: typeof parsed.message === "string" ? parsed.message : value,
    };
  } catch {
    return { failureClass: null, message: value };
  }
}

function asNullableNumber(value: string | number | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
