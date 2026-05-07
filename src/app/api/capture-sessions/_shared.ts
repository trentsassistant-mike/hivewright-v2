import { canAccessHive, canMutateHive } from "@/auth/users";
import type { AuthenticatedApiUser } from "../_lib/auth";
import { sql } from "../_lib/db";
import { jsonError } from "../_lib/responses";
import type { NextResponse } from "next/server";

export const CAPTURE_SESSION_STATUSES = [
  "draft",
  "recording",
  "stopped",
  "analysis_pending",
  "review_ready",
  "cancelled",
  "deleted",
] as const;

export type CaptureSessionStatus = (typeof CAPTURE_SESSION_STATUSES)[number];

const RAW_MEDIA_FIELD_NAMES = new Set([
  "video",
  "rawVideo",
  "videoBlob",
  "rawVideoBlob",
  "videoBytes",
  "rawVideoBytes",
  "media",
  "rawMedia",
  "mediaBlob",
  "mediaBytes",
  "recording",
  "recordingBlob",
  "recordingBytes",
  "frame",
  "frames",
  "screenshot",
  "screenshotBlob",
  "screenshotBytes",
  "screenshots",
  "rawAudio",
  "audioBlob",
  "audioBytes",
  "file",
  "files",
  "chunks",
]);

const ALLOWED_TRANSITIONS: Record<CaptureSessionStatus, CaptureSessionStatus[]> = {
  draft: ["recording", "cancelled", "deleted"],
  recording: ["stopped", "cancelled", "deleted"],
  stopped: ["analysis_pending", "review_ready", "cancelled", "deleted"],
  analysis_pending: ["review_ready", "cancelled", "deleted"],
  review_ready: ["deleted"],
  cancelled: ["deleted"],
  deleted: [],
};

export function isCaptureSessionStatus(value: unknown): value is CaptureSessionStatus {
  return typeof value === "string" &&
    CAPTURE_SESSION_STATUSES.includes(value as CaptureSessionStatus);
}

export function canTransitionCaptureSession(
  from: CaptureSessionStatus,
  to: CaptureSessionStatus,
): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}

export function validateMetadataOnlyContentType(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("multipart/form-data")) {
    return jsonError(
      "metadata-only capture sessions do not accept raw media uploads or multipart payloads",
      415,
    );
  }
  return null;
}

export function findRawMediaField(value: unknown, path = "body"): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findRawMediaField(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (RAW_MEDIA_FIELD_NAMES.has(key)) return `${path}.${key}`;
    const found = findRawMediaField(nested, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

type MetadataOnlyJsonResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: NextResponse };

export async function readMetadataOnlyJson(
  request: Request,
): Promise<MetadataOnlyJsonResult> {
  const contentTypeError = validateMetadataOnlyContentType(request);
  if (contentTypeError) return { ok: false, response: contentTypeError };

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: jsonError("invalid JSON body", 400) };
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, response: jsonError("body must be a JSON object", 400) };
  }

  const rawField = findRawMediaField(body);
  if (rawField) {
    return {
      ok: false,
      response: jsonError(
        `metadata-only capture sessions cannot include raw media field '${rawField}'`,
        400,
      ),
    };
  }

  return { ok: true, body: body as Record<string, unknown> };
}

export async function ensureCanReadHive(user: AuthenticatedApiUser, hiveId: string) {
  if (user.isSystemOwner) return null;
  const hasAccess = await canAccessHive(sql, user.id, hiveId);
  if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
  return null;
}

export async function ensureCanMutateHive(user: AuthenticatedApiUser, hiveId: string) {
  if (user.isSystemOwner) return null;
  const hasAccess = await canMutateHive(sql, user.id, hiveId);
  if (!hasAccess) return jsonError("Forbidden: caller cannot mutate this hive", 403);
  return null;
}

export function captureSessionRowToApi(row: Record<string, unknown>) {
  return {
    id: row.id,
    hiveId: row.hive_id,
    ownerUserId: row.owner_user_id,
    ownerEmail: row.owner_email,
    status: row.status,
    consentedAt: row.consented_at,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    cancelledAt: row.cancelled_at,
    deletedAt: row.deleted_at,
    captureScope: row.capture_scope,
    metadata: row.metadata,
    evidenceSummary: row.evidence_summary,
    redactedSummary: row.redacted_summary,
    workProductRefs: row.work_product_refs,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type OptionalObjectResult =
  | { ok: true; value: Record<string, unknown> | null | undefined }
  | { ok: false; error: string };

export function optionalObject(value: unknown, label: string): OptionalObjectResult {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: `${label} must be an object` };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

type OptionalStringArrayResult =
  | { ok: true; value: string[] | undefined }
  | { ok: false; error: string };

export function optionalStringArray(
  value: unknown,
  label: string,
): OptionalStringArrayResult {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return { ok: false, error: `${label} must be an array of strings` };
  }
  return { ok: true, value };
}
