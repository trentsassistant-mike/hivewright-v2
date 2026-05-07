import { requireApiUser } from "../_lib/auth";
import { sql } from "../_lib/db";
import { jsonError, jsonOk } from "../_lib/responses";
import {
  captureSessionRowToApi,
  ensureCanMutateHive,
  ensureCanReadHive,
  isCaptureSessionStatus,
  optionalObject,
  optionalStringArray,
  readMetadataOnlyJson,
  type CaptureSessionStatus,
} from "./_shared";
import {
  AGENT_AUDIT_EVENTS,
} from "@/audit/agent-events";
import { maybeRecordRedactionApplied, recordCaptureAuditEvent } from "./_audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonParam(value: unknown) {
  return sql.json(value as Parameters<typeof sql.json>[0]);
}

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const url = new URL(request.url);
  // hive-access-not-required: ensureCanReadHive delegates to canAccessHive for this hiveId read.
  const hiveId = url.searchParams.get("hiveId");
  if (!hiveId) return jsonError("hiveId is required", 400);

  const accessError = await ensureCanReadHive(authz.user, hiveId);
  if (accessError) return accessError;

  const status = url.searchParams.get("status");
  if (status !== null && !isCaptureSessionStatus(status)) {
    return jsonError(
      "invalid status (must be draft | recording | stopped | analysis_pending | review_ready | cancelled | deleted)",
      400,
    );
  }

  const rows = status
    ? await sql`
        SELECT *
        FROM capture_sessions
        WHERE hive_id = ${hiveId} AND status = ${status}
        ORDER BY created_at DESC
      `
    : await sql`
        SELECT *
        FROM capture_sessions
        WHERE hive_id = ${hiveId}
        ORDER BY created_at DESC
      `;

  return jsonOk(rows.map((row) => captureSessionRowToApi(row)));
}

export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const parsed = await readMetadataOnlyJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  if (typeof body.hiveId !== "string" || body.hiveId.trim() === "") {
    return jsonError("hiveId is required", 400);
  }
  const hiveId = body.hiveId.trim();

  if (body.consent !== true) {
    return jsonError("consent=true is required to create a capture session", 400);
  }

  const accessError = await ensureCanMutateHive(authz.user, hiveId);
  if (accessError) return accessError;

  const [hive] = await sql`SELECT id FROM hives WHERE id = ${hiveId}`;
  if (!hive) return jsonError("hive not found", 404);

  if (
    body.status !== undefined &&
    (typeof body.status !== "string" || !["draft", "recording"].includes(body.status))
  ) {
    return jsonError("initial status must be draft or recording", 400);
  }
  const initialStatus: CaptureSessionStatus =
    body.status === undefined ? "draft" : body.status as CaptureSessionStatus;

  const captureScope = optionalObject(body.captureScope, "captureScope");
  if (!captureScope.ok) return jsonError(captureScope.error, 400);

  const metadata = optionalObject(body.metadata, "metadata");
  if (!metadata.ok) return jsonError(metadata.error, 400);
  if (metadata.value === null) return jsonError("metadata must be an object", 400);

  const evidenceSummary = optionalObject(body.evidenceSummary, "evidenceSummary");
  if (!evidenceSummary.ok) return jsonError(evidenceSummary.error, 400);

  const workProductRefs = optionalStringArray(body.workProductRefs, "workProductRefs");
  if (!workProductRefs.ok) return jsonError(workProductRefs.error, 400);

  if (
    body.redactedSummary !== undefined &&
    body.redactedSummary !== null &&
    typeof body.redactedSummary !== "string"
  ) {
    return jsonError("redactedSummary must be a string", 400);
  }

  const [row] = await sql`
    INSERT INTO capture_sessions (
      hive_id,
      owner_user_id,
      owner_email,
      status,
      started_at,
      capture_scope,
      metadata,
      evidence_summary,
      redacted_summary,
      work_product_refs
    )
    VALUES (
      ${hiveId},
      ${authz.user.id},
      ${authz.user.email},
      ${initialStatus},
      ${initialStatus === "recording" ? new Date() : null},
      ${captureScope.value === undefined ? null : jsonParam(captureScope.value)},
      ${jsonParam(metadata.value ?? {})},
      ${evidenceSummary.value === undefined ? null : jsonParam(evidenceSummary.value)},
      ${typeof body.redactedSummary === "string" ? body.redactedSummary : null},
      ${jsonParam(workProductRefs.value ?? [])}
    )
    RETURNING *
  `;

  if (initialStatus === "recording") {
    await recordCaptureAuditEvent({
      sql,
      request,
      user: authz.user,
      eventType: AGENT_AUDIT_EVENTS.captureStarted,
      session: row,
      previousStatus: null,
      nextStatus: "recording",
      metadata: {
        createdFromConsent: true,
      },
    });
  }
  await maybeRecordRedactionApplied({
    sql,
    request,
    user: authz.user,
    session: row,
    previousStatus: null,
    nextStatus: initialStatus,
    metadata: {
      source: "capture_session_create",
    },
  });

  return jsonOk(captureSessionRowToApi(row), 201);
}
