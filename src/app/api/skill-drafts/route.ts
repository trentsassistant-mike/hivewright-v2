import { canAccessHive } from "@/auth/users";
import { sql } from "../_lib/db";
import { jsonOk, jsonError, parseSearchParams } from "../_lib/responses";
import {
  enforceInternalTaskHiveScope,
  requireApiAuth,
  requireApiUser,
  type AuthenticatedApiUser,
} from "../_lib/auth";
import {
  approveSkill,
  archiveSkill,
  proposeSkill,
  publishSkill,
  rejectSkill,
  reviewSkill,
} from "@/skills/self-creation";
import { maybeRecordEaHiveSwitch } from "@/ea/native/hive-switch-audit";
import {
  AGENT_AUDIT_EVENTS,
  recordAgentAuditEventBestEffort,
} from "@/audit/agent-events";

function captureSessionIdFromInternalRef(value: string | null | undefined): string | null {
  const prefix = "capture-session:";
  return value?.startsWith(prefix) ? value.slice(prefix.length) : null;
}

async function recordCaptureDerivedSkillDraftAudit(input: {
  request: Request;
  draft: {
    id: string;
    hiveId: string;
    internalSourceRef: string | null;
    provenanceUrl: string | null;
    status: string;
  };
  eventType: typeof AGENT_AUDIT_EVENTS.draftWorkflowEdited |
    typeof AGENT_AUDIT_EVENTS.draftWorkflowApproved |
    typeof AGENT_AUDIT_EVENTS.draftWorkflowRejected |
    typeof AGENT_AUDIT_EVENTS.workflowActivated;
  actorId: string;
  previousStatus?: string;
  metadata?: Record<string, unknown>;
}) {
  const captureSessionId = captureSessionIdFromInternalRef(input.draft.internalSourceRef);
  if (!captureSessionId) return;

  await recordAgentAuditEventBestEffort(sql, {
    eventType: input.eventType,
    actor: {
      type: input.actorId === "system" ? "system" : "owner",
      id: input.actorId,
      label: input.actorId,
    },
    hiveId: input.draft.hiveId,
    targetType: "skill_draft",
    targetId: input.draft.id,
    outcome: "success",
    metadata: {
      occurredAt: new Date().toISOString(),
      captureSessionId,
      skillDraftId: input.draft.id,
      previousStatus: input.previousStatus ?? null,
      nextStatus: input.draft.status,
      route: new URL(input.request.url).pathname,
      provenanceRoute: input.draft.provenanceUrl,
      rawMediaPresent: false,
      ...input.metadata,
    },
  });
}

async function authorizeSkillDraftMutation(
  draftId: string,
  user: AuthenticatedApiUser,
): Promise<
  | { ok: true; draft: { id: string; hiveId: string } }
  | { ok: false; response: Response }
> {
  const [draft] = await sql<{ id: string; hiveId: string }[]>`
    SELECT id, hive_id AS "hiveId"
    FROM skill_drafts
    WHERE id = ${draftId}
    LIMIT 1
  `;

  if (!draft) {
    return { ok: false, response: jsonError(`Skill draft not found: ${draftId}`, 404) };
  }

  const taskScope = await enforceInternalTaskHiveScope(draft.hiveId);
  if (!taskScope.ok) return { ok: false, response: taskScope.response };

  if (!user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, user.id, draft.hiveId);
    if (!hasAccess) {
      return {
        ok: false,
        response: jsonError("Forbidden: caller cannot access this draft hive", 403),
      };
    }
  }

  return { ok: true, draft };
}

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;

  try {
    const params = parseSearchParams(request.url);
    const hiveId = params.get("hiveId");
    const status = params.get("status");
    if (hiveId && !user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, user.id, hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this hive", 403);
      }
    }

    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (hiveId) {
      conditions.push(`hive_id = $${paramIdx++}`);
      values.push(hiveId);
    } else if (!user.isSystemOwner) {
      conditions.push(
        `hive_id IN (SELECT hive_id FROM hive_memberships WHERE user_id = $${paramIdx++})`,
      );
      values.push(user.id);
    }
    if (status) {
      conditions.push(`status = $${paramIdx++}`);
      values.push(status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = await sql.unsafe(
      `SELECT *
       FROM skill_drafts ${whereClause}
       ORDER BY created_at DESC`,
      values as string[],
    );

    const data = (rows as unknown as Record<string, unknown>[]).map((r) => ({
      id: r.id,
      hiveId: r.hive_id,
      roleSlug: r.role_slug,
      targetRoleSlugs: r.target_role_slugs,
      sourceTaskId: r.source_task_id,
      originatingTaskId: r.originating_task_id,
      originatingFeedbackId: r.originating_feedback_id,
      slug: r.slug,
      content: r.content,
      scope: r.scope,
      sourceType: r.source_type,
      provenanceUrl: r.provenance_url,
      internalSourceRef: r.internal_source_ref,
      licenseNotes: r.license_notes,
      securityReviewStatus: r.security_review_status,
      qaReviewStatus: r.qa_review_status,
      evidence: r.evidence,
      status: r.status,
      feedback: r.feedback,
      approvedBy: r.approved_by,
      approvedAt: r.approved_at,
      publishedBy: r.published_by,
      publishedAt: r.published_at,
      archivedBy: r.archived_by,
      archivedAt: r.archived_at,
      archiveReason: r.archive_reason,
      adoptionEvidence: r.adoption_evidence,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    return jsonOk(data);
  } catch {
    return jsonError("Failed to fetch skill drafts", 500);
  }
}

export async function POST(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  try {
    const body = await request.json();
    const {
      hiveId,
      roleSlug,
      targetRoleSlugs,
      sourceTaskId,
      originatingTaskId,
      originatingFeedbackId,
      slug,
      content,
      scope,
      sourceType,
      provenanceUrl,
      internalSourceRef,
      licenseNotes,
      securityReviewStatus,
      qaReviewStatus,
      evidence,
    } = body as {
      hiveId: string;
      roleSlug: string;
      targetRoleSlugs?: string[];
      sourceTaskId?: string;
      originatingTaskId?: string;
      originatingFeedbackId?: string;
      slug: string;
      content: string;
      scope: string;
      sourceType?: "internal" | "external";
      provenanceUrl?: string;
      internalSourceRef?: string;
      licenseNotes?: string;
      securityReviewStatus?: "pending" | "approved" | "rejected" | "not_required";
      qaReviewStatus?: "pending" | "approved" | "rejected" | "not_required";
      evidence?: [];
    };

    if (!hiveId || !roleSlug || !slug || !content || !scope) {
      return jsonError("Missing required fields: hiveId, roleSlug, slug, content, scope", 400);
    }

    if (scope !== "system" && scope !== "hive") {
      return jsonError('scope must be "system" or "hive"', 400);
    }
    if (sourceType && sourceType !== "internal" && sourceType !== "external") {
      return jsonError('sourceType must be "internal" or "external"', 400);
    }

    const taskScope = await enforceInternalTaskHiveScope(hiveId);
    if (!taskScope.ok) return taskScope.response;

    if (sourceTaskId) {
      const [sourceTask] = await sql`
        SELECT 1 FROM tasks WHERE id = ${sourceTaskId} AND hive_id = ${hiveId} LIMIT 1
      `;
      if (!sourceTask) return jsonError("Forbidden: source task does not belong to hive", 403);
    }

    const draft = await proposeSkill(sql, {
      hiveId,
      roleSlug,
      targetRoleSlugs,
      sourceTaskId,
      originatingTaskId,
      originatingFeedbackId,
      slug,
      content,
      scope,
      sourceType,
      provenanceUrl,
      internalSourceRef,
      licenseNotes,
      securityReviewStatus,
      qaReviewStatus,
      evidence,
    });

    await maybeRecordEaHiveSwitch(sql, request, hiveId, {
      type: "skill_draft",
      id: draft.id,
    });
    return jsonOk(draft, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to propose skill draft";
    const status = message.includes("cap") ? 409 : 500;
    return jsonError(message, status);
  }
}

export async function PATCH(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;

  try {
    const body = await request.json();
    const { id, action, feedback, reviewer, publishedBy, archivedBy, reason, securityReviewStatus, qaReviewStatus, licenseNotes, provenanceUrl } = body as {
      id: string;
      action: string;
      feedback?: string;
      reviewer?: string;
      publishedBy?: string;
      archivedBy?: string;
      reason?: string;
      securityReviewStatus?: "pending" | "approved" | "rejected" | "not_required";
      qaReviewStatus?: "pending" | "approved" | "rejected" | "not_required";
      licenseNotes?: string;
      provenanceUrl?: string;
    };

    if (!id || !action) {
      return jsonError("Missing required fields: id, action", 400);
    }

    if (!["review", "approve", "reject", "publish", "archive"].includes(action)) {
      return jsonError('action must be one of "review", "approve", "reject", "publish", or "archive"', 400);
    }

    const access = await authorizeSkillDraftMutation(id, user);
    if (!access.ok) return access.response;

    let draft;
    if (action === "review") {
      draft = await reviewSkill(sql, id, {
        reviewer: reviewer ?? "system",
        securityReviewStatus,
        qaReviewStatus,
        feedback,
        licenseNotes,
        provenanceUrl,
      });
      await recordCaptureDerivedSkillDraftAudit({
        request,
        draft,
        eventType: AGENT_AUDIT_EVENTS.draftWorkflowEdited,
        actorId: reviewer ?? "system",
        previousStatus: "pending",
        metadata: {
          source: "skill_drafts_patch_review",
          securityReviewStatusProvided: Boolean(securityReviewStatus),
          qaReviewStatusProvided: Boolean(qaReviewStatus),
          feedbackProvided: Boolean(feedback),
          licenseNotesProvided: Boolean(licenseNotes),
          provenanceUrlProvided: Boolean(provenanceUrl),
        },
      });
    } else if (action === "approve") {
      draft = await approveSkill(sql, id, reviewer ?? "system");
      await recordCaptureDerivedSkillDraftAudit({
        request,
        draft,
        eventType: AGENT_AUDIT_EVENTS.draftWorkflowApproved,
        actorId: reviewer ?? "system",
        previousStatus: "reviewing",
        metadata: {
          source: "skill_drafts_patch_approve",
          activationStatus: "inactive",
        },
      });
    } else {
      if (action === "publish") {
        draft = await publishSkill(sql, id, publishedBy ?? reviewer ?? "system");
        await recordCaptureDerivedSkillDraftAudit({
          request,
          draft,
          eventType: AGENT_AUDIT_EVENTS.workflowActivated,
          actorId: publishedBy ?? reviewer ?? "system",
          previousStatus: "approved",
          metadata: {
            source: "skill_drafts_patch_publish",
          },
        });
        return jsonOk(draft);
      }
      if (action === "archive") {
        if (!reason) {
          return jsonError("reason is required when archiving a draft", 400);
        }
        draft = await archiveSkill(sql, id, archivedBy ?? reviewer ?? "system", reason);
        return jsonOk(draft);
      }
      if (!feedback) {
        return jsonError("feedback is required when rejecting a draft", 400);
      }
      draft = await rejectSkill(sql, id, feedback);
      await recordCaptureDerivedSkillDraftAudit({
        request,
        draft,
        eventType: AGENT_AUDIT_EVENTS.draftWorkflowRejected,
        actorId: reviewer ?? "system",
        previousStatus: "reviewing",
        metadata: {
          source: "skill_drafts_patch_reject",
          feedbackProvided: true,
        },
      });
    }

    return jsonOk(draft);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update skill draft";
    const status = message.includes("not found") ? 404 : 500;
    return jsonError(message, status);
  }
}
