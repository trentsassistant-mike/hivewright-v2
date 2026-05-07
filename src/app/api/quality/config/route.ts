import { canAccessHive } from "@/auth/users";
import { maybeRecordEaHiveSwitch } from "@/ea/native/hive-switch-audit";
import {
  OWNER_FEEDBACK_ADAPTER_TYPE,
  loadOwnerFeedbackSamplingConfig,
  loadOwnerFeedbackSamplingConfigState,
  saveOwnerFeedbackSamplingConfig,
  validateOwnerFeedbackSamplingPatch,
} from "@/quality/owner-feedback-config";
import { sql } from "../../_lib/db";
import { requireApiUser } from "../../_lib/auth";
import { jsonError, jsonOk, parseSearchParams } from "../../_lib/responses";

async function requireHiveAccess(
  user: { id: string; isSystemOwner: boolean },
  hiveId: string,
) {
  if (user.isSystemOwner) return null;
  const hasAccess = await canAccessHive(sql, user.id, hiveId);
  return hasAccess ? null : jsonError("Forbidden: hive access required", 403);
}

function toResponseData(config: Awaited<ReturnType<typeof loadOwnerFeedbackSamplingConfig>>) {
  const effective = {
    owner_feedback_sample_rate: config.sampleRate,
    ai_peer_feedback_sample_rate: config.aiPeerReviewSampleRate,
    owner_feedback_eligibility_window_days: config.eligibilityWindowDays,
    owner_feedback_duplicate_cooldown_days: config.duplicateCooldownDays,
    owner_feedback_per_role_daily_cap: config.perRoleDailyCap,
    owner_feedback_per_day_cap: config.perDayCap,
  };
  return {
    effective,
    ownerFeedbackSampleRate: config.sampleRate,
    aiPeerFeedbackSampleRate: config.aiPeerReviewSampleRate,
    eligibilityWindowDays: config.eligibilityWindowDays,
    duplicateCooldownDays: config.duplicateCooldownDays,
    perRoleDailyCap: config.perRoleDailyCap,
    perDayCap: config.perDayCap,
  };
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
    const state = await loadOwnerFeedbackSamplingConfigState(sql, hiveId);
    return jsonOk({
      hiveId,
      adapterType: OWNER_FEEDBACK_ADAPTER_TYPE,
      ...toResponseData(state.effectiveConfig),
      source: state.source,
      override: state.rawRow?.hiveId === hiveId ? state.rawRow.config : null,
      rawRow: state.rawRow,
    });
  } catch (err) {
    console.error("[quality config GET] failed:", err);
    return jsonError("Failed to fetch quality config", 500);
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

  const parsed = validateOwnerFeedbackSamplingPatch(body);
  if ("error" in parsed) return jsonError(parsed.error, 400);

  try {
    const configId = await saveOwnerFeedbackSamplingConfig(sql, hiveId, parsed);
    await maybeRecordEaHiveSwitch(sql, request, hiveId, {
      type: "adapter_config",
      id: configId,
    });
    const state = await loadOwnerFeedbackSamplingConfigState(sql, hiveId);
    return jsonOk({
      hiveId,
      adapterType: OWNER_FEEDBACK_ADAPTER_TYPE,
      ...toResponseData(state.effectiveConfig),
      source: state.source,
      override: state.rawRow?.hiveId === hiveId ? state.rawRow.config : null,
      rawRow: state.rawRow,
    });
  } catch (err) {
    console.error("[quality config PATCH] failed:", err);
    return jsonError("Failed to save quality config", 500);
  }
}
