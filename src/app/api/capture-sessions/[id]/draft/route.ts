import { requireApiUser } from "../../../_lib/auth";
import { sql } from "../../../_lib/db";
import { jsonError, jsonOk } from "../../../_lib/responses";
import { AGENT_AUDIT_EVENTS } from "@/audit/agent-events";
import {
  buildCaptureDraftEvidence,
  type CaptureDraftPreview,
  generateCaptureDraftPreview,
  getCaptureDraftMetadata,
} from "../../_draft";
import { recordCaptureAuditEvent } from "../../_audit";
import {
  ensureCanMutateHive,
  findRawMediaField,
  readMetadataOnlyJson,
  type CaptureSessionStatus,
} from "../../_shared";
import { proposeSkill } from "@/skills/self-creation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonParam(value: unknown) {
  return sql.json(value as Parameters<typeof sql.json>[0]);
}

async function loadSession(id: string) {
  const [row] = await sql`SELECT * FROM capture_sessions WHERE id = ${id} LIMIT 1`;
  return row as Record<string, unknown> | undefined;
}

async function readOptionalMetadataOnlyJson(request: Request) {
  if (!request.headers.get("content-type")) {
    return { ok: true as const, body: {} as Record<string, unknown> };
  }
  return readMetadataOnlyJson(request);
}

async function loadExistingDraft(sessionId: string) {
  const [row] = await sql`
    SELECT *
    FROM skill_drafts
    WHERE internal_source_ref = ${`capture-session:${sessionId}`}
      AND status IN ('pending', 'reviewing', 'approved')
    ORDER BY created_at ASC NULLS LAST
    LIMIT 1
  `;
  return row as Record<string, unknown> | undefined;
}

function draftRowToApi(row: Record<string, unknown>) {
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    qaReviewStatus: row.qaReviewStatus ?? row.qa_review_status,
    securityReviewStatus: row.securityReviewStatus ?? row.security_review_status,
    internalSourceRef: row.internalSourceRef ?? row.internal_source_ref ?? null,
    provenanceUrl: row.provenanceUrl ?? row.provenance_url ?? null,
    publishedAt: row.publishedAt ?? row.published_at ?? null,
  };
}

function metadataWithDraft(
  existing: Record<string, unknown> | null,
  captureDraft: Record<string, unknown>,
) {
  return {
    ...(existing ?? {}),
    captureDraft: {
      ...((existing?.captureDraft && typeof existing.captureDraft === "object")
        ? existing.captureDraft as Record<string, unknown>
        : {}),
      ...captureDraft,
    },
  };
}

function validateStoredMetadataOnly(session: Record<string, unknown>) {
  const rawField = findRawMediaField({
    metadata: session.metadata,
    evidenceSummary: session.evidence_summary,
    captureScope: session.capture_scope,
  }, "captureSession");
  return rawField
    ? jsonError(`metadata-only capture session cannot generate draft from raw media field '${rawField}'`, 400)
    : null;
}

function stringFromBody(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function draftContent(input: {
  suggestedSkillContent: string;
  sessionId: string;
  reviewRoute: string;
  reviewNotes: string | null;
}) {
  return [
    input.suggestedSkillContent.trim(),
    "",
    "## Capture provenance",
    "",
    "Status: inactive pending draft.",
    "AI step inference: pending future review; this draft uses metadata-only capture evidence.",
    `Capture session ID: ${input.sessionId}`,
    `Review route: ${input.reviewRoute}`,
    input.reviewNotes ? `Review notes: ${input.reviewNotes}` : null,
  ].filter(Boolean).join("\n");
}

function previewFromBody(
  preview: CaptureDraftPreview,
  body: Record<string, unknown>,
): CaptureDraftPreview {
  const suggestedSkillContent = stringFromBody(body, "suggestedSkillContent");
  if (!suggestedSkillContent) return preview;
  return {
    ...preview,
    suggestedSkillContent,
  };
}

function sessionRefs(session: Record<string, unknown>) {
  return Array.isArray(session.work_product_refs)
    ? [...session.work_product_refs as string[]]
    : [];
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  const session = await loadSession(id);
  if (!session || session.status === "deleted") {
    return jsonError("capture session not found", 404);
  }

  const accessError = await ensureCanMutateHive(authz.user, session.hive_id as string);
  if (accessError) return accessError;
  const rawMediaError = validateStoredMetadataOnly(session);
  if (rawMediaError) return rawMediaError;

  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  const existing = getCaptureDraftMetadata(metadata);
  const preview = existing.preview ?? generateCaptureDraftPreview(session);

  if (!existing.preview) {
    await sql`
      UPDATE capture_sessions
      SET metadata = ${jsonParam(metadataWithDraft(metadata, {
            preview,
            previewStatus: "generated",
            generatedAt: new Date().toISOString(),
            rawMediaAccepted: false,
          }))},
          updated_at = NOW()
      WHERE id = ${id}
    `;
  }

  return jsonOk({
    preview,
    previewStatus: existing.previewStatus ?? "generated",
    approvedDraftId: existing.approvedDraftId ?? null,
    approvedDraftStatus: existing.approvedDraftStatus ?? null,
    rawMediaAccepted: false,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  const session = await loadSession(id);
  if (!session || session.status === "deleted") {
    return jsonError("capture session not found", 404);
  }

  const accessError = await ensureCanMutateHive(authz.user, session.hive_id as string);
  if (accessError) return accessError;
  const rawMediaError = validateStoredMetadataOnly(session);
  if (rawMediaError) return rawMediaError;

  const parsed = await readOptionalMetadataOnlyJson(request);
  if (!parsed.ok) return parsed.response;

  const reviewRoute = `/setup/workflow-capture/${id}/review`;
  const duplicateDraft = await loadExistingDraft(id);
  if (duplicateDraft) {
    return jsonOk({
      draft: draftRowToApi(duplicateDraft),
      created: false,
      duplicate: true,
      message: "Existing inactive pending draft found for this capture session.",
      rawMediaAccepted: false,
    });
  }

  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  const existing = getCaptureDraftMetadata(metadata);
  const generatedPreview = existing.preview ?? generateCaptureDraftPreview(session);
  const preview = previewFromBody(generatedPreview, parsed.body);
  const content = draftContent({
    suggestedSkillContent: preview.suggestedSkillContent,
    sessionId: id,
    reviewRoute,
    reviewNotes: stringFromBody(parsed.body, "reviewNotes"),
  });

  try {
    const draft = await proposeSkill(sql, {
      hiveId: session.hive_id as string,
      roleSlug: preview.roleSlug,
      targetRoleSlugs: [preview.roleSlug],
      slug: preview.slug,
      content,
      scope: preview.scope,
      sourceType: "internal",
      internalSourceRef: `capture-session:${id}`,
      provenanceUrl: reviewRoute,
      licenseNotes: "Metadata-only owner capture; no raw video, audio, screenshots, frames, or media blobs accepted or processed.",
      securityReviewStatus: "not_required",
      qaReviewStatus: "pending",
      evidence: buildCaptureDraftEvidence(preview).map((item) => ({
        ...item,
        summary: `${item.summary} Review route: ${reviewRoute}`,
      })),
    });

    const refs = sessionRefs(session);
    const draftRef = `skill_draft:${draft.id}`;
    await sql`
      UPDATE capture_sessions
      SET metadata = ${jsonParam(metadataWithDraft(metadata, {
            preview,
            previewStatus: "approved",
            approvedDraftId: draft.id,
            approvedDraftStatus: draft.status,
            draftId: draft.id,
            draftStatus: draft.status,
            sourceType: "skill_draft",
            sourceRef: draftRef,
            reviewRoute,
            approvedAt: new Date().toISOString(),
            rawMediaAccepted: false,
          }))},
          work_product_refs = ${jsonParam(refs.includes(draftRef) ? refs : [...refs, draftRef])},
          updated_at = NOW()
      WHERE id = ${id}
    `;

    const status = session.status as CaptureSessionStatus;
    await recordCaptureAuditEvent({
      sql,
      request,
      user: authz.user,
      eventType: AGENT_AUDIT_EVENTS.draftWorkflowCreated,
      session,
      previousStatus: status,
      nextStatus: status,
      targetType: "skill_draft",
      targetId: draft.id,
      metadata: {
        captureSessionId: id,
        skillDraftId: draft.id,
        draftStatus: draft.status,
        activationStatus: "inactive",
        sourceType: "capture_session_metadata",
      },
    });
    await recordCaptureAuditEvent({
      sql,
      request,
      user: authz.user,
      eventType: AGENT_AUDIT_EVENTS.draftWorkflowApproved,
      session,
      previousStatus: status,
      nextStatus: status,
      targetType: "skill_draft",
      targetId: draft.id,
      metadata: {
        captureSessionId: id,
        skillDraftId: draft.id,
        workflowDraftId: draft.id,
        workflowSourceRef: `capture-session:${id}`,
        draftStatus: draft.status,
        activationStatus: "inactive",
        sourceType: "capture_session_metadata",
      },
    });

    return jsonOk({
      draft: {
        id: draft.id,
        slug: draft.slug,
        status: draft.status,
        qaReviewStatus: draft.qaReviewStatus,
        securityReviewStatus: draft.securityReviewStatus,
        internalSourceRef: draft.internalSourceRef,
        provenanceUrl: draft.provenanceUrl,
        publishedAt: draft.publishedAt,
      },
      created: true,
      duplicate: false,
      message: "Inactive pending draft created from capture session metadata.",
      rawMediaAccepted: false,
    }, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create draft";
    return jsonError(message, message.includes("cap") ? 409 : 500);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id } = await params;
  const session = await loadSession(id);
  if (!session || session.status === "deleted") {
    return jsonError("capture session not found", 404);
  }

  const accessError = await ensureCanMutateHive(authz.user, session.hive_id as string);
  if (accessError) return accessError;
  const rawMediaError = validateStoredMetadataOnly(session);
  if (rawMediaError) return rawMediaError;

  const parsed = await readOptionalMetadataOnlyJson(request);
  if (!parsed.ok) return parsed.response;

  const metadata = (session.metadata ?? {}) as Record<string, unknown>;
  const reason = stringFromBody(parsed.body, "reason");
  await sql`
    UPDATE capture_sessions
    SET metadata = ${jsonParam(metadataWithDraft(metadata, {
          previewStatus: "rejected",
          rejectedAt: new Date().toISOString(),
          rejectionReason: reason,
          rawMediaAccepted: false,
        }))},
        updated_at = NOW()
    WHERE id = ${id}
  `;

  const status = session.status as CaptureSessionStatus;
  await recordCaptureAuditEvent({
    sql,
    request,
    user: authz.user,
    eventType: AGENT_AUDIT_EVENTS.draftWorkflowRejected,
    session,
    previousStatus: status,
    nextStatus: status,
    targetType: "capture_draft_preview",
    targetId: id,
    metadata: {
      captureSessionId: id,
      draftPreviewId: id,
      workflowSourceRef: `capture-session:${id}`,
      previewStatus: "rejected",
      rejectionReason: reason ? "provided" : "unspecified",
      sourceType: "capture_session_metadata",
    },
  });

  return jsonOk({
    previewStatus: "rejected",
    rejected: true,
    rawMediaAccepted: false,
  });
}
