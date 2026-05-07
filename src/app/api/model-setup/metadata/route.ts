import { refreshModelCatalogMetadata } from "@/model-catalog/catalog";
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
    const result = await refreshModelCatalogMetadata(sql, {
      hiveId,
      fetchLiveMetadata: true,
    });
    return jsonOk({ hiveId, result });
  } catch (err) {
    console.error("[model-setup metadata POST] failed:", err);
    return jsonError("Failed to refresh model metadata", 500);
  }
}
