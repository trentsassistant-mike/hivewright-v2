import { requireApiUser } from "../../_lib/auth";
import { sql } from "../../_lib/db";
import { jsonError, jsonOk } from "../../_lib/responses";
import {
  canTransitionCaptureSession,
  captureSessionRowToApi,
  ensureCanMutateHive,
  ensureCanReadHive,
  isCaptureSessionStatus,
  optionalObject,
  optionalStringArray,
  readMetadataOnlyJson,
  type CaptureSessionStatus,
} from "../_shared";
import { AGENT_AUDIT_EVENTS } from "@/audit/agent-events";
import { maybeRecordRedactionApplied, recordCaptureAuditEvent } from "../_audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonParam(value: unknown) {
  return sql.json(value as Parameters<typeof sql.json>[0]);
}

async function loadSession(id: string) {
  const [row] = await sql`SELECT * FROM capture_sessions WHERE id = ${id} LIMIT 1`;
  return row as Record<string, unknown> | undefined;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  const row = await loadSession(id);
  if (!row) return jsonError("capture session not found", 404);

  const accessError = await ensureCanReadHive(authz.user, row.hive_id as string);
  if (accessError) return accessError;

  return jsonOk(captureSessionRowToApi(row));
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  const existing = await loadSession(id);
  if (!existing) return jsonError("capture session not found", 404);

  const accessError = await ensureCanMutateHive(authz.user, existing.hive_id as string);
  if (accessError) return accessError;

  const parsed = await readMetadataOnlyJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const currentStatus = existing.status as CaptureSessionStatus;
  const requestedStatus = body.status;
  if (requestedStatus !== undefined && !isCaptureSessionStatus(requestedStatus)) {
    return jsonError(
      "invalid status (must be draft | recording | stopped | analysis_pending | review_ready | cancelled | deleted)",
      400,
    );
  }

  const nextStatus = requestedStatus ?? currentStatus;
  if (!canTransitionCaptureSession(currentStatus, nextStatus)) {
    return jsonError(`invalid capture session transition: ${currentStatus} -> ${nextStatus}`, 400);
  }

  const metadata = optionalObject(body.metadata, "metadata");
  if (!metadata.ok) return jsonError(metadata.error, 400);
  if (metadata.value === null) return jsonError("metadata must be an object", 400);

  const evidenceSummary = optionalObject(body.evidenceSummary, "evidenceSummary");
  if (!evidenceSummary.ok) return jsonError(evidenceSummary.error, 400);

  const captureScope = optionalObject(body.captureScope, "captureScope");
  if (!captureScope.ok) return jsonError(captureScope.error, 400);

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
    UPDATE capture_sessions
    SET
      status = ${nextStatus},
      started_at = CASE
        WHEN ${nextStatus} = 'recording' AND started_at IS NULL THEN NOW()
        ELSE started_at
      END,
      stopped_at = CASE
        WHEN ${nextStatus} = 'stopped' AND stopped_at IS NULL THEN NOW()
        ELSE stopped_at
      END,
      cancelled_at = CASE
        WHEN ${nextStatus} = 'cancelled' AND cancelled_at IS NULL THEN NOW()
        ELSE cancelled_at
      END,
      deleted_at = CASE
        WHEN ${nextStatus} = 'deleted' AND deleted_at IS NULL THEN NOW()
        ELSE deleted_at
      END,
      capture_scope = CASE
        WHEN ${captureScope.value !== undefined} THEN ${captureScope.value === undefined ? null : jsonParam(captureScope.value)}
        ELSE capture_scope
      END,
      metadata = CASE
        WHEN ${metadata.value !== undefined} THEN ${metadata.value === undefined ? null : jsonParam(metadata.value)}
        ELSE metadata
      END,
      evidence_summary = CASE
        WHEN ${evidenceSummary.value !== undefined} THEN ${evidenceSummary.value === undefined ? null : jsonParam(evidenceSummary.value)}
        ELSE evidence_summary
      END,
      redacted_summary = CASE
        WHEN ${body.redactedSummary !== undefined} THEN ${body.redactedSummary ?? null}
        ELSE redacted_summary
      END,
      work_product_refs = CASE
        WHEN ${workProductRefs.value !== undefined} THEN ${workProductRefs.value === undefined ? null : jsonParam(workProductRefs.value)}
        ELSE work_product_refs
      END,
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;

  if (currentStatus !== nextStatus && nextStatus === "stopped") {
    await recordCaptureAuditEvent({
      sql,
      request,
      user: authz.user,
      eventType: AGENT_AUDIT_EVENTS.captureStopped,
      session: row,
      previousStatus: currentStatus,
      nextStatus,
    });
  }
  if (currentStatus !== nextStatus && nextStatus === "cancelled") {
    await recordCaptureAuditEvent({
      sql,
      request,
      user: authz.user,
      eventType: AGENT_AUDIT_EVENTS.captureCancelled,
      session: row,
      previousStatus: currentStatus,
      nextStatus,
    });
  }
  await maybeRecordRedactionApplied({
    sql,
    request,
    user: authz.user,
    session: row,
    previousStatus: currentStatus,
    nextStatus,
    metadata: {
      source: "capture_session_update",
    },
  });

  return jsonOk(captureSessionRowToApi(row));
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  const existing = await loadSession(id);
  if (!existing) return jsonError("capture session not found", 404);

  const accessError = await ensureCanMutateHive(authz.user, existing.hive_id as string);
  if (accessError) return accessError;

  await recordCaptureAuditEvent({
    sql,
    request: _request,
    user: authz.user,
    eventType: AGENT_AUDIT_EVENTS.draftWorkflowDeleted,
    session: existing,
    previousStatus: existing.status as CaptureSessionStatus,
    nextStatus: "deleted",
    targetType: "capture_session",
    targetId: id,
    metadata: {
      source: "capture_session_delete",
      deletedDerivedCaptureSessionMetadata: true,
    },
  });

  await sql`DELETE FROM capture_sessions WHERE id = ${id}`;
  return jsonOk({ id, purged: true });
}
