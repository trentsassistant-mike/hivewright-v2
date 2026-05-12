import type { Sql } from "postgres";
import { canAccessHive } from "@/auth/users";
import { jsonError, jsonOk } from "../../_lib/responses";
import { requireApiUser } from "../../_lib/auth";
import {
  appSql,
  fetchInitiativeRunById,
  fetchInitiativeRunDecisions,
  summarizeInitiativeRun,
} from "../queries";

const HIVE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SerializedClassification = {
  provider?: string;
  model?: string;
  confidence?: number;
  reasoning?: string;
  usedFallback?: boolean;
  role?: string;
} | null;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function serializeClassification(value: unknown): SerializedClassification {
  const record = asRecord(value);
  if (!record) return null;

  const classification: NonNullable<SerializedClassification> = {};
  if (typeof record.provider === "string") classification.provider = record.provider;
  if (typeof record.model === "string") classification.model = record.model;
  if (typeof record.confidence === "number") classification.confidence = record.confidence;
  if (typeof record.reasoning === "string") classification.reasoning = record.reasoning;
  if (typeof record.usedFallback === "boolean") classification.usedFallback = record.usedFallback;
  if (typeof record.role === "string") classification.role = record.role;

  return Object.keys(classification).length > 0 ? classification : null;
}

function extractSuppressionReasons(value: unknown): string[] {
  const suppression = asRecord(value);
  const reasons = new Set<string>();

  if (typeof suppression?.reason === "string") reasons.add(suppression.reason);

  if (Array.isArray(suppression?.reasons)) {
    for (const reason of suppression.reasons) {
      if (typeof reason === "string") reasons.add(reason);
    }
  } else {
    const reasonMap = asRecord(suppression?.reasons);
    if (reasonMap) {
      for (const [reason, present] of Object.entries(reasonMap)) {
        if (present) reasons.add(reason);
      }
    }
  }

  return Array.from(reasons);
}

function extractClassifiedRole(
  creation: Record<string, unknown> | null,
  classification: SerializedClassification,
): string | null {
  if (typeof classification?.role === "string") return classification.role;
  if (typeof creation?.assignedTo === "string") return creation.assignedTo;
  if (typeof creation?.assigned_role === "string") return creation.assigned_role;
  return null;
}

function inferWorkItemType(
  creation: Record<string, unknown> | null,
  decision: Awaited<ReturnType<typeof fetchInitiativeRunDecisions>>[number],
): string | null {
  if (typeof creation?.workItemType === "string") return creation.workItemType;
  if (decision.created_task_id) return "task";
  if (decision.created_goal_id) return "goal";
  if (decision.action_taken === "create_task") return "task";
  if (decision.action_taken === "create_goal") return "goal";
  return null;
}

function extractDecisionEvidence(value: unknown): {
  suppressionReason: string | null;
  suppressionReasons: string[];
  classifiedOutcome: {
    workItemType: string | null;
    classification: SerializedClassification;
    classifiedRole: string | null;
  } | null;
} {
  const evidence = asRecord(value);
  const suppression = asRecord(evidence?.suppression);
  const creation = asRecord(evidence?.creation);

  const classification = serializeClassification(creation?.classification);
  const suppressionReasons = extractSuppressionReasons(suppression);
  const classifiedRole = extractClassifiedRole(creation, classification);

  return {
    suppressionReason: typeof suppression?.reason === "string" ? suppression.reason : null,
    suppressionReasons,
    classifiedOutcome: classification || classifiedRole
      ? {
          workItemType: null,
          classification,
          classifiedRole,
        }
      : null,
  };
}

function serializeDecision(
  decision: Awaited<ReturnType<typeof fetchInitiativeRunDecisions>>[number],
) {
  const extractedEvidence = extractDecisionEvidence(decision.evidence);
  const creation = asRecord(asRecord(decision.evidence)?.creation);
  const workItemType = inferWorkItemType(creation, decision);

  return {
    id: decision.id,
    runId: decision.runId,
    candidate_key: decision.candidate_key,
    candidate_ref: decision.candidate_ref,
    candidate_kind: decision.candidate_kind,
    target_goal_id: decision.target_goal_id,
    target_goal_title: decision.target_goal_title,
    action_taken: decision.action_taken,
    created_goal_id: decision.created_goal_id,
    created_goal_title: decision.created_goal_title,
    created_task_id: decision.created_task_id,
    created_task_title: decision.created_task_title,
    suppression_reason: decision.suppression_reason ?? extractedEvidence.suppressionReason,
    suppression_reasons: extractedEvidence.suppressionReasons.length > 0
      ? extractedEvidence.suppressionReasons
      : decision.suppression_reason
        ? [decision.suppression_reason]
        : [],
    rationale: decision.rationale,
    classified_outcome: workItemType
      || extractedEvidence.classifiedOutcome?.classification
      || extractedEvidence.classifiedOutcome?.classifiedRole
      ? {
          workItemType,
          classification: extractedEvidence.classifiedOutcome?.classification ?? null,
          classifiedRole: extractedEvidence.classifiedOutcome?.classifiedRole ?? null,
        }
      : null,
  };
}

async function getInitiativeRunDetail(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
  db: Sql,
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;

  try {
    const { runId } = await params;
    if (!HIVE_ID_RE.test(runId)) {
      return jsonError("runId must be a valid UUID", 400);
    }

    const url = new URL(request.url);
    const hiveId = url.searchParams.get("hiveId");
    if (!hiveId) return jsonError("hiveId is required", 400);
    if (!HIVE_ID_RE.test(hiveId)) {
      return jsonError("hiveId must be a valid UUID", 400);
    }
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(db, user.id, hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this hive", 403);
      }
    }

    const [run, decisions] = await Promise.all([
      fetchInitiativeRunById(db, hiveId, runId),
      fetchInitiativeRunDecisions(db, hiveId, runId),
    ]);

    if (!run) {
      return jsonError("Initiative run not found", 404);
    }

    return jsonOk({
      run: {
        ...summarizeInitiativeRun(run),
        runId: run.id,
        decisions: decisions.map(serializeDecision),
      },
    });
  } catch (error) {
    console.error("[api/initiative-runs/[runId]] failed:", error);
    return jsonError("Failed to fetch initiative run", 500);
  }
}

export function createGetInitiativeRunDetailHandler(db: Sql = appSql) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ runId: string }> },
  ) {
    return getInitiativeRunDetail(request, context, db);
  };
}
