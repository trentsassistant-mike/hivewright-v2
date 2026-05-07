import type { Sql } from "postgres";
import type { AuthenticatedApiUser } from "../_lib/auth";
import {
  AGENT_AUDIT_EVENTS,
  recordAgentAuditEventBestEffort,
  type AgentAuditEventType,
} from "@/audit/agent-events";

type CaptureAuditStatus =
  | "draft"
  | "recording"
  | "stopped"
  | "analysis_pending"
  | "review_ready"
  | "cancelled"
  | "deleted";

type CaptureAuditOutcome = "success" | "error" | "blocked" | "skipped";

type CaptureAuditInput = {
  sql: Sql;
  request?: Request;
  user: AuthenticatedApiUser;
  eventType: AgentAuditEventType;
  session: Record<string, unknown>;
  previousStatus?: CaptureAuditStatus | null;
  nextStatus?: CaptureAuditStatus | null;
  targetType?: string;
  targetId?: string | null;
  outcome?: CaptureAuditOutcome;
  metadata?: Record<string, unknown>;
};

function actorForUser(user: AuthenticatedApiUser) {
  return {
    type: user.email === "service@hivewright.local" ? "service" as const : "owner" as const,
    id: user.id,
    label: user.email,
  };
}

function requestId(request?: Request): string | null {
  return request?.headers.get("x-request-id") ??
    request?.headers.get("x-correlation-id") ??
    null;
}

function captureScopeType(scope: unknown): string | null {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const type = (scope as Record<string, unknown>).type;
  return typeof type === "string" ? type : null;
}

function stringArrayCount(source: unknown, keys: string[]): number {
  if (!source || typeof source !== "object" || Array.isArray(source)) return 0;
  const record = source as Record<string, unknown>;
  return keys.reduce((count, key) => {
    const value = record[key];
    return count + (Array.isArray(value) ? value.filter((item) => typeof item === "string").length : 0);
  }, 0);
}

export function captureRedactionSignal(input: {
  metadata?: unknown;
  evidenceSummary?: unknown;
  redactedSummary?: unknown;
}): { hasRedaction: boolean; sensitiveWarningCount: number; redactionNoteCount: number } {
  const sensitiveWarningCount =
    stringArrayCount(input.metadata, ["sensitiveDataWarnings", "sensitiveWarnings"]) +
    stringArrayCount(input.evidenceSummary, ["sensitiveDataWarnings", "sensitiveWarnings"]);
  const redactionNoteCount =
    stringArrayCount(input.metadata, ["redactionNotes"]) +
    stringArrayCount(input.evidenceSummary, ["redactionNotes"]);
  const hasRedactedSummary =
    typeof input.redactedSummary === "string" && input.redactedSummary.trim().length > 0;

  return {
    hasRedaction: hasRedactedSummary || sensitiveWarningCount > 0 || redactionNoteCount > 0,
    sensitiveWarningCount,
    redactionNoteCount,
  };
}

export async function recordCaptureAuditEvent(input: CaptureAuditInput): Promise<void> {
  const sessionId = typeof input.session.id === "string" ? input.session.id : null;
  const hiveId = typeof input.session.hive_id === "string" ? input.session.hive_id : null;
  const redaction = captureRedactionSignal({
    metadata: input.session.metadata,
    evidenceSummary: input.session.evidence_summary,
    redactedSummary: input.session.redacted_summary,
  });

  await recordAgentAuditEventBestEffort(input.sql, {
    eventType: input.eventType,
    actor: actorForUser(input.user),
    hiveId,
    targetType: input.targetType ?? "capture_session",
    targetId: input.targetId ?? sessionId,
    outcome: input.outcome ?? "success",
    requestId: requestId(input.request),
    metadata: {
      occurredAt: new Date().toISOString(),
      captureSessionId: sessionId,
      previousStatus: input.previousStatus ?? null,
      nextStatus: input.nextStatus ?? input.session.status ?? null,
      ownerUserId: typeof input.session.owner_user_id === "string"
        ? input.session.owner_user_id
        : input.user.id,
      ownerEmail: typeof input.session.owner_email === "string"
        ? input.session.owner_email
        : input.user.email,
      route: input.request ? new URL(input.request.url).pathname : null,
      provenanceRoute: sessionId ? `/setup/workflow-capture/${sessionId}/review` : null,
      captureScopeType: captureScopeType(input.session.capture_scope),
      rawMediaPresent: false,
      sensitiveWarningCount: redaction.sensitiveWarningCount,
      redactionNoteCount: redaction.redactionNoteCount,
      redactionApplied: redaction.hasRedaction,
      ...input.metadata,
    },
  });
}

export async function maybeRecordRedactionApplied(input: Omit<CaptureAuditInput, "eventType">) {
  const redaction = captureRedactionSignal({
    metadata: input.session.metadata,
    evidenceSummary: input.session.evidence_summary,
    redactedSummary: input.session.redacted_summary,
  });
  if (!redaction.hasRedaction) return;

  await recordCaptureAuditEvent({
    ...input,
    eventType: AGENT_AUDIT_EVENTS.redactionApplied,
    metadata: {
      ...(input.metadata ?? {}),
      sensitiveWarningCount: redaction.sensitiveWarningCount,
      redactionNoteCount: redaction.redactionNoteCount,
    },
  });
}
