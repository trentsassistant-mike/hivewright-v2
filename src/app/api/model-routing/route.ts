import { canAccessHive } from "@/auth/users";
import {
  normalizeModelRoutingPolicy,
  saveModelRoutingPolicy,
  MODEL_ROUTING_ADAPTER_CONFIG_TYPE,
} from "@/model-routing/policy";
import { loadModelRoutingView } from "@/model-routing/registry";
import { AUTO_MODEL_ROUTE, resolveConfiguredModelRoute } from "@/model-routing/selector";
import { sql } from "../_lib/db";
import { requireApiUser } from "../_lib/auth";
import { jsonError, jsonOk, parseSearchParams } from "../_lib/responses";

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

  const denied = await requireHiveAccess(authz.user, hiveId);
  if (denied) return denied;

  try {
    const view = await loadModelRoutingView(sql, hiveId);
    const previewTitle = params.get("previewTitle");
    const previewBrief = params.get("previewBrief");
    const previewAcceptanceCriteria = params.get("previewAcceptanceCriteria");
    const previewRoute = previewTitle !== null || previewBrief !== null || previewAcceptanceCriteria !== null
      ? resolveConfiguredModelRoute({
          roleSlug: params.get("previewRoleSlug") ?? "preview",
          roleType: params.get("previewRoleType"),
          manualAdapterType: AUTO_MODEL_ROUTE,
          manualModel: AUTO_MODEL_ROUTE,
          policy: view.policy,
          taskContext: {
            taskTitle: previewTitle,
            taskBrief: previewBrief,
            acceptanceCriteria: previewAcceptanceCriteria,
            retryCount: 0,
          },
        })
      : null;

    return jsonOk({
      hiveId,
      adapterType: MODEL_ROUTING_ADAPTER_CONFIG_TYPE,
      source: view.basePolicyState.source,
      policy: view.policy,
      models: view.models,
      profiles: view.profiles,
      rawRow: view.basePolicyState.rawRow,
      previewRoute,
    });
  } catch (err) {
    console.error("[model-routing GET] failed:", err);
    return jsonError("Failed to fetch model routing config", 500);
  }
}

export async function PATCH(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }

  const hiveId = typeof body.hiveId === "string" ? body.hiveId : "";
  if (!hiveId) return jsonError("hiveId is required", 400);

  const denied = await requireHiveAccess(authz.user, hiveId);
  if (denied) return denied;

  const policy = normalizeModelRoutingPolicy(body.policy);
  if (!policy) return jsonError("policy is required", 400);
  const persistedPolicy = {
    preferences: policy.preferences,
    routeOverrides: policy.routeOverrides,
    roleRoutes: policy.roleRoutes,
    candidates: [],
  };

  try {
    const id = await saveModelRoutingPolicy(sql, hiveId, persistedPolicy);
    const view = await loadModelRoutingView(sql, hiveId);
    return jsonOk({
      hiveId,
      adapterType: MODEL_ROUTING_ADAPTER_CONFIG_TYPE,
      source: view.basePolicyState.source,
      policy: view.policy,
      models: view.models,
      profiles: view.profiles,
      rawRow: view.basePolicyState.rawRow,
      updated: true,
      id,
    });
  } catch (err) {
    console.error("[model-routing PATCH] failed:", err);
    return jsonError("Failed to save model routing config", 500);
  }
}
