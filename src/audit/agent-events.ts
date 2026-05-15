import type { Sql } from "postgres";

export const AGENT_AUDIT_EVENTS = {
  credentialDecryptedForAgentSpawn: "credential.decrypted_for_agent_spawn",
  connectorTokenUsed: "connector.token_used",
  encryptionKeyAccessed: "credential.encryption_key_accessed",
  credentialRevokedByOwner: "credential.revoked_by_owner",
  connectorRevokedByOwner: "connector.revoked_by_owner",
  decisionCreated: "decision.created",
  decisionUpdated: "decision.updated",
  decisionApproved: "decision.approved",
  decisionResolved: "decision.resolved",
  decisionRejected: "decision.rejected",
  hiveMemoryWritten: "hive_memory.written",
  captureStarted: "capture_started",
  captureStopped: "capture_stopped",
  captureCancelled: "capture_cancelled",
  captureUploaded: "capture_uploaded",
  redactionApplied: "redaction_applied",
  draftWorkflowCreated: "draft_workflow_created",
  draftWorkflowEdited: "draft_workflow_edited",
  draftWorkflowApproved: "draft_workflow_approved",
  draftWorkflowRejected: "draft_workflow_rejected",
  draftWorkflowDeleted: "draft_workflow_deleted",
  httpWebhookPost: "http_webhook_post",
  workflowActivated: "workflow_activated",
  codexEmptyOutputFailure: "codex_empty_output_failure",
  taskLifecycleTransition: "task.lifecycle_transition",
  toolGrantDecision: "tool.grant_decision",
} as const;

export type AgentAuditEventType =
  (typeof AGENT_AUDIT_EVENTS)[keyof typeof AGENT_AUDIT_EVENTS];

export interface AgentAuditActor {
  type?: "system" | "owner" | "role" | "agent" | "service";
  id?: string | null;
  label?: string | null;
}

export interface AgentAuditContext {
  actor?: AgentAuditActor;
  hiveId?: string | null;
  goalId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  requestId?: string | null;
}

export interface RecordAgentAuditEventInput extends AgentAuditContext {
  eventType: AgentAuditEventType;
  targetType: string;
  targetId?: string | null;
  outcome: "success" | "error" | "blocked" | "skipped";
  metadata?: Record<string, unknown>;
}

const SENSITIVE_METADATA_KEYS = new Set([
  "accessToken",
  "apiKey",
  "authorization",
  "cookie",
  "content",
  "credentialValue",
  "decryptedPayload",
  "draft",
  "draftContent",
  "encryptionKey",
  "frames",
  "password",
  "plaintext",
  "rawKey",
  "rawMedia",
  "rawVideo",
  "refreshToken",
  "recording",
  "recordingBlob",
  "screenshots",
  "secret",
  "suggestedSkillContent",
  "token",
  "value",
  "video",
  "videoBlob",
  "webhookUrl",
  "workflowDraft",
]);

function isSensitiveMetadataKey(key: string): boolean {
  if (key === "rawMediaPresent") return false;
  if (SENSITIVE_METADATA_KEYS.has(key)) return true;
  const normalized = key.toLowerCase();
  return (
    normalized.includes("accesstoken") ||
    normalized.includes("refreshtoken") ||
    normalized.includes("authorization") ||
    normalized.includes("decrypted") ||
    normalized.includes("draftcontent") ||
    normalized.includes("rawmedia") ||
    normalized.includes("rawvideo") ||
    normalized.includes("recordingblob") ||
    normalized.includes("password") ||
    normalized.includes("plaintext") ||
    normalized.includes("secret") ||
    normalized.includes("screenshots") ||
    normalized.includes("videoblob") ||
    normalized.includes("webhookurl")
  );
}

export function sanitizeAuditMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditMetadata(item));
  if (value === null || typeof value !== "object") return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    sanitized[key] = isSensitiveMetadataKey(key)
      ? "[REDACTED]"
      : sanitizeAuditMetadata(entry);
  }
  return sanitized;
}

export async function recordAgentAuditEvent(
  sql: Sql,
  input: RecordAgentAuditEventInput,
): Promise<void> {
  const actor = input.actor ?? {};
  const metadata = sanitizeAuditMetadata(input.metadata ?? {}) as Record<string, unknown>;

  await sql`
    INSERT INTO agent_audit_events (
      event_type,
      actor_type,
      actor_id,
      actor_label,
      hive_id,
      goal_id,
      task_id,
      agent_id,
      target_type,
      target_id,
      outcome,
      request_id,
      metadata
    )
    VALUES (
      ${input.eventType},
      ${actor.type ?? "system"},
      ${actor.id ?? null},
      ${actor.label ?? null},
      ${input.hiveId ?? null},
      ${input.goalId ?? null},
      ${input.taskId ?? null},
      ${input.agentId ?? null},
      ${input.targetType},
      ${input.targetId ?? null},
      ${input.outcome},
      ${input.requestId ?? null},
      ${sql.json(metadata as Parameters<typeof sql.json>[0])}
    )
  `;
}

export async function recordAgentAuditEventBestEffort(
  sql: Sql,
  input: RecordAgentAuditEventInput,
): Promise<void> {
  try {
    await recordAgentAuditEvent(sql, input);
  } catch {
    // Audit writes must not break task execution or owner operations.
  }
}
