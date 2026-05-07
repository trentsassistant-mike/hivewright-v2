import { runModelHealthProbes } from "@/model-health/probe-runner";
import { requireApiAuth, requireSystemOwner } from "../../_lib/auth";
import { sql } from "../../_lib/db";
import { jsonError, jsonOk } from "../../_lib/responses";

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 250;

export async function POST(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }

  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    return jsonError("ENCRYPTION_KEY is not configured for model health probes", 503);
  }

  const hiveId = normalizeOptionalString(body.hiveId);
  const limit = normalizeLimit(body.limit);
  const includeFresh = body.includeFresh === true;
  const includeOnDemand = body.includeOnDemand === true;

  try {
    const result = await runModelHealthProbes(sql, {
      hiveId,
      encryptionKey,
      limit,
      includeFresh,
      includeOnDemand,
    });

    return jsonOk({
      hiveId,
      limit,
      includeFresh,
      includeOnDemand,
      result,
    });
  } catch (err) {
    console.error("[model-health probe POST] failed:", err);
    return jsonError("Failed to run model health probes", 500);
  }
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeLimit(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(numeric), 1), MAX_LIMIT);
}
