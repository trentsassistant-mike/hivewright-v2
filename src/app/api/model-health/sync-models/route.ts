import { syncConfiguredHiveModels } from "@/model-health/sync-models";
import { requireSystemOwner } from "../../_lib/auth";
import { sql } from "../../_lib/db";
import { jsonError, jsonOk } from "../../_lib/responses";

export async function POST(request: Request) {
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }

  const hiveId = typeof body.hiveId === "string" ? body.hiveId.trim() : "";
  if (!hiveId) return jsonError("hiveId is required", 400);

  try {
    const result = await syncConfiguredHiveModels(sql, { hiveId });
    return jsonOk({ hiveId, result });
  } catch (err) {
    console.error("[model-health sync-models POST] failed:", err);
    return jsonError("Failed to sync configured models", 500);
  }
}
