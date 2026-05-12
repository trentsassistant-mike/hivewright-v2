import { sql } from "../../../_lib/db";
import { jsonOk, jsonError } from "../../../_lib/responses";
import { requireApiUser } from "../../../_lib/auth";
import { TASK_QUALITY_FEEDBACK_DECISION_KIND } from "@/quality/owner-feedback-sampler";
import { maybeCreateQualityDoctorForSignal } from "@/quality/doctor";
import { mirrorOwnerDecisionCommentToGoalComment } from "@/decisions/owner-comment-wake";
import { decisionEventForResponse, recordDecisionAuditEvent } from "../../_audit";
import { canAccessHive, canMutateHive } from "@/auth/users";
import { createOrUpdateSkillCandidateFromSignal } from "@/skills/self-creation";
import { applyApprovedLearningGateFollowup, LEARNING_GATE_FOLLOWUP_DECISION_KIND } from "@/goals/learning-gate-approval";
import { executeApprovedExternalAction, rejectExternalAction, type ExecuteExternalActionResult } from "@/actions/external-actions";

const DIRECT_TASK_QA_CAP_ACTIONS = [
  "retry_with_different_role",
  "refine_brief_and_retry",
  "abandon",
] as const;
const VALID_RESPONSES = ["approved", "rejected", "discussed", ...DIRECT_TASK_QA_CAP_ACTIONS] as const;
type ValidResponse = (typeof VALID_RESPONSES)[number];
type DirectTaskQaCapAction = (typeof DIRECT_TASK_QA_CAP_ACTIONS)[number];
const QUALITY_FEEDBACK_RESPONSES = ["quality_feedback", "dismiss_quality_feedback"] as const;
type QualityFeedbackResponse = (typeof QUALITY_FEEDBACK_RESPONSES)[number];
const MAX_RESPONSE_COMMENT_LENGTH = 2000;
const EXTERNAL_ACTION_APPROVAL_DECISION_KIND = "external_action_approval";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RELEASE_SCAN_MODEL_PROPOSAL_KINDS = new Set([
  "release_scan_model_proposal",
  "release-scan-model-proposal",
  "llm_model_release_proposal",
  "model_release_proposal",
]);

const MODEL_REGISTRY_PATCH_TARGETS = [
  "src/adapters/provider-config.ts",
  "roles model list (src/app/(dashboard)/roles/page.tsx)",
  "adapter settings model list (src/app/(dashboard)/setup/adapters/page.tsx)",
  "hive creation model list (src/app/(dashboard)/hives/new/page.tsx)",
];

type DecisionRowForModelProposal = {
  id: string;
  hive_id: string;
  goal_id: string | null;
  task_id: string | null;
  title: string;
  context: string;
  recommendation: string | null;
  options: unknown;
  kind: string;
  route_metadata: unknown;
  priority?: string;
  status?: string;
  owner_response?: string | null;
  selected_option_key?: string | null;
  selected_option_label?: string | null;
  created_at?: Date;
  resolved_at?: Date | null;
  is_qa_fixture: boolean;
};

type NamedDecisionOption = {
  key: string;
  label: string;
  response: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function nestedRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) return value;
  }
  return null;
}

function optionArrayFromDecisionOptions(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  return Array.isArray(value.options) ? value.options : [];
}

function normaliseDecisionOption(value: unknown): NamedDecisionOption | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? { key: trimmed, label: trimmed, response: null } : null;
  }

  if (!isRecord(value)) return null;

  const key = stringField(value, ["key", "action", "id", "value"]);
  const label = stringField(value, ["label", "title", "name"]) ?? key;
  if (!key || !label) return null;

  const explicitResponse = stringField(value, ["response", "canonicalResponse", "canonical_response"]);
  const action = stringField(value, ["action"]);
  const response = explicitResponse ??
    (action && VALID_RESPONSES.includes(action as ValidResponse) ? action : null);

  return { key, label, response };
}

function getNamedDecisionOptions(value: unknown): NamedDecisionOption[] {
  return optionArrayFromDecisionOptions(value)
    .map(normaliseDecisionOption)
    .filter((option): option is NamedDecisionOption => option !== null);
}

function findNamedDecisionOption(value: unknown, key: string): NamedDecisionOption | null {
  return getNamedDecisionOptions(value).find((option) => option.key === key) ?? null;
}

function responseForExternalActionOption(option: NamedDecisionOption): ValidResponse | null {
  if (option.key === "approve") {
    return "approved";
  }
  if (option.key === "reject") {
    return "rejected";
  }
  return null;
}

function externalActionRequestIdFromMetadata(routeMetadata: unknown): string | null {
  if (!isRecord(routeMetadata)) return null;
  const requestId = stringField(routeMetadata, ["externalActionRequestId", "external_action_request_id"]);
  return requestId && UUID_RE.test(requestId) ? requestId : null;
}

async function validateExternalActionDecisionLink(
  decisionId: string,
  hiveId: string,
  routeMetadata: unknown,
): Promise<string | Response> {
  const requestId = externalActionRequestIdFromMetadata(routeMetadata);
  if (!requestId) {
    return jsonError("External action approval decision is missing a valid external action request id", 400);
  }

  const [request] = await sql<{ id: string }[]>`
    SELECT id
    FROM external_action_requests
    WHERE id = ${requestId}::uuid
      AND hive_id = ${hiveId}::uuid
      AND decision_id = ${decisionId}::uuid
    LIMIT 1
  `;
  if (!request) {
    return jsonError("External action approval decision references an external action request that was not found for this hive", 400);
  }
  return requestId;
}

function extractReleaseScanModelPayload(
  decision: Pick<DecisionRowForModelProposal, "kind" | "options">,
): Record<string, unknown> | null {
  const options = isRecord(decision.options) ? decision.options : null;
  const explicitKind = decision.kind;
  const optionKind = options
    ? stringField(options, ["kind", "tag", "type", "proposalKind"])
    : null;

  if (RELEASE_SCAN_MODEL_PROPOSAL_KINDS.has(explicitKind)) {
    return nestedRecord(options ?? {}, ["modelProposal", "releaseScanModelProposal", "payload"]) ?? options ?? {};
  }

  if (optionKind && RELEASE_SCAN_MODEL_PROPOSAL_KINDS.has(optionKind)) {
    return nestedRecord(options ?? {}, ["modelProposal", "releaseScanModelProposal", "payload"]) ?? options ?? {};
  }

  if (options && isRecord(options.releaseScanModelProposal)) {
    return options.releaseScanModelProposal;
  }

  if (options && isRecord(options.modelProposal)) {
    const source = stringField(options.modelProposal, ["source", "origin", "scanner"]);
    if (source === "release-scan") return options.modelProposal;
  }

  return null;
}

function isDirectTaskQaCapAction(response: string): response is DirectTaskQaCapAction {
  return (DIRECT_TASK_QA_CAP_ACTIONS as readonly string[]).includes(response);
}

function isDirectTaskQaCapDecision(decision: Pick<DecisionRowForModelProposal, "options">): boolean {
  const options = isRecord(decision.options) ? decision.options : null;
  return stringField(options ?? {}, ["kind"]) === "direct_task_qa_cap_recovery";
}

function isQualityFeedbackResponse(response: string): response is QualityFeedbackResponse {
  return (QUALITY_FEEDBACK_RESPONSES as readonly string[]).includes(response);
}

function isTaskQualityFeedbackDecision(decision: Pick<DecisionRowForModelProposal, "kind" | "options">): boolean {
  const options = isRecord(decision.options) ? decision.options : null;
  return decision.kind === TASK_QUALITY_FEEDBACK_DECISION_KIND ||
    stringField(options ?? {}, ["kind"]) === TASK_QUALITY_FEEDBACK_DECISION_KIND;
}

function qualityFeedbackLane(decision: Pick<DecisionRowForModelProposal, "options">): "owner" | "ai_peer" {
  const options = isRecord(decision.options) ? decision.options : null;
  return stringField(options ?? {}, ["lane"]) === "ai_peer" ? "ai_peer" : "owner";
}

function normaliseQualityRating(value: unknown): number | null {
  const n = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number(value)
      : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 10) return null;
  return n;
}

function signalTypeForRating(rating: number): "positive" | "neutral" | "negative" {
  if (rating >= 7) return "positive";
  if (rating <= 4) return "negative";
  return "neutral";
}

async function applyTaskQualityFeedbackResponse(
  decision: DecisionRowForModelProposal,
  rating: number | null,
  comment?: string,
): Promise<void> {
  if (!isTaskQualityFeedbackDecision(decision) || !decision.task_id || rating === null) return;
  const lane = qualityFeedbackLane(decision);
  const source = lane === "ai_peer" ? "explicit_ai_peer_feedback" : "explicit_owner_feedback";
  const reviewerLabel = lane === "ai_peer" ? "AI peer reviewer" : "owner";

  const evidence = [
    `Decision ${decision.id}: ${reviewerLabel} rated task quality ${rating}/10.`,
    comment?.trim() ? `${lane === "ai_peer" ? "AI peer review" : "Owner comment"}: ${comment.trim()}` : null,
  ].filter((line): line is string => line !== null).join("\n");

  const inserted = await sql<{ id: string }[]>`
    INSERT INTO task_quality_signals (
      task_id, hive_id, signal_type, source, evidence,
      confidence, rating, comment, is_qa_fixture
    )
    SELECT
      ${decision.task_id}::uuid,
      ${decision.hive_id}::uuid,
      ${signalTypeForRating(rating)},
      ${source},
      ${evidence},
      1,
      ${rating},
      ${comment?.trim() || null},
      ${decision.is_qa_fixture}
    WHERE NOT EXISTS (
      SELECT 1
      FROM task_quality_signals
      WHERE task_id = ${decision.task_id}::uuid
        AND hive_id = ${decision.hive_id}::uuid
        AND source = ${source}
        AND evidence LIKE ${`Decision ${decision.id}:%`}
    )
    RETURNING id
  `;
  if (inserted.length > 0 && !decision.is_qa_fixture) {
    await maybeCreateQualityDoctorForSignal(sql, decision.task_id, {
      source,
      signalType: signalTypeForRating(rating),
      rating,
      evidence,
      confidence: 1,
    });

    if (rating <= 6) {
      const [task] = await sql<{ assigned_to: string; title: string }[]>`
        SELECT assigned_to, title
        FROM tasks
        WHERE id = ${decision.task_id}::uuid
          AND hive_id = ${decision.hive_id}::uuid
      `;

      if (task?.assigned_to) {
        try {
          await createOrUpdateSkillCandidateFromSignal(sql, {
            hiveId: decision.hive_id,
            roleSlug: task.assigned_to,
            taskId: decision.task_id,
            feedbackId: inserted[0].id,
            signalType: "feedback",
            rating,
            summary: [
              `Low task-quality rating for "${task.title}" (${rating}/10).`,
              comment?.trim() ? `Feedback: ${comment.trim()}` : evidence,
            ].join("\n"),
            source,
          });
        } catch (error) {
          console.warn(
            `[skills] Failed to create/update skill candidate from quality feedback ${inserted[0].id}:`,
            error,
          );
        }
      }
    }
  }
}

function directTaskRecoveryBriefNote(response: DirectTaskQaCapAction, comment?: string): string {
  const actionLabel = response === "retry_with_different_role"
    ? "Retry with a different role"
    : response === "refine_brief_and_retry"
      ? "Refine the brief and retry"
      : "Abandon this task";

  return [
    "## Owner Recovery Decision",
    `Action: ${actionLabel}`,
    comment?.trim() ? `Owner note: ${comment.trim()}` : null,
  ].filter((line): line is string => line !== null).join("\n");
}

async function applyDirectTaskQaCapResponse(
  decision: DecisionRowForModelProposal,
  response: DirectTaskQaCapAction,
  comment?: string,
): Promise<void> {
  if (!isDirectTaskQaCapDecision(decision) || !decision.task_id) return;

  if (response === "abandon") {
    await sql`
      UPDATE tasks
      SET status = 'cancelled',
          failure_reason = ${comment?.trim()
            ? `Abandoned by owner after QA retry cap: ${comment.trim()}`
            : "Abandoned by owner after QA retry cap."},
          updated_at = NOW()
      WHERE id = ${decision.task_id}
        AND hive_id = ${decision.hive_id}
        AND status = 'blocked'
    `;
    return;
  }

  await sql`
    UPDATE tasks
    SET status = 'pending',
        brief = brief || ${`\n\n${directTaskRecoveryBriefNote(response, comment)}`},
        retry_count = 0,
        retry_after = NULL,
        failure_reason = NULL,
        updated_at = NOW()
    WHERE id = ${decision.task_id}
      AND hive_id = ${decision.hive_id}
      AND status = 'blocked'
  `;
}

function buildModelRegistryPatchBrief(
  decision: DecisionRowForModelProposal,
  payload: Record<string, unknown>,
): string {
  const modelId = stringField(payload, ["modelId", "model", "id", "apiModelId", "internalModelId"]);
  const provider = stringField(payload, ["provider", "vendor", "company"]);
  const displayName = stringField(payload, ["displayName", "name"]);
  const marker = `release-scan-decision:${decision.id}`;
  const payloadJson = stableStringify(payload);

  return [
    "# Developer Agent",
    "",
    "Implement the owner-approved release-scan model-registry proposal.",
    "",
    `Decision marker: ${marker}`,
    `Decision title: ${decision.title}`,
    `Decision id: ${decision.id}`,
    decision.goal_id ? `Goal id: ${decision.goal_id}` : null,
    modelId ? `Model id: ${modelId}` : null,
    displayName ? `Display name: ${displayName}` : null,
    provider ? `Provider: ${provider}` : null,
    "",
    "Owner-approved proposal payload:",
    "```json",
    payloadJson,
    "```",
    "",
    "Patch the same model-registry surfaces used in Sprint 1:",
    ...MODEL_REGISTRY_PATCH_TARGETS.map((target) => `- ${target}`),
    "",
    "Implementation requirements:",
    "- Add the model to the provider pricing/config map with the exact approved pricing and model identifier from the payload.",
    "- Add the model to the roles model list.",
    "- Add the model to the adapter settings model list.",
    "- Add the model to the hive creation model list.",
    "- Preserve any required internal routing alias from the payload; do not invent a public provider model name.",
    "",
    "Verification requirements:",
    "- Verify the model is selectable in the roles dropdown.",
    "- Verify the model is selectable in the adapter settings dropdown.",
    "- Verify the model is selectable in the hive creation dropdown.",
    "- Verify a role can be assigned to the model.",
    "- Verify dispatcher cost tracker coverage for the new provider-config entry.",
    "",
    "Commit and rebuild instructions:",
    "- Run the focused tests that cover the changed model registry and dispatcher cost tracking surfaces.",
    "- Run `npm run build` after the patch.",
    "- Run `git status` and stage only the files changed for this implementation.",
    "- Commit the implementation with a clear conventional commit message.",
    "- Include the created commit SHA and rebuild/test results in the task result summary.",
  ].filter((line): line is string => line !== null).join("\n");
}

async function queueModelRegistryPatchTaskIfNeeded(
  decision: DecisionRowForModelProposal,
): Promise<string | null> {
  const payload = extractReleaseScanModelPayload(decision);
  if (!payload) return null;

  const marker = `release-scan-decision:${decision.id}`;
  const brief = buildModelRegistryPatchBrief(decision, payload);
  const titleModel = stringField(payload, ["modelId", "model", "id", "apiModelId", "internalModelId"]) ??
    stringField(payload, ["displayName", "name"]) ??
    "approved model";
  const title = `Patch model registry for ${titleModel}`;

  const [task] = await sql.begin(async (tx) => {
    await tx`
      SELECT id FROM decisions WHERE id = ${decision.id} FOR UPDATE
    `;
    const [existing] = await tx<{ id: string }[]>`
      SELECT id
      FROM tasks
      WHERE hive_id = ${decision.hive_id}
        AND assigned_to = 'dev-agent'
        AND created_by = 'decision-release-scan'
        AND brief LIKE ${`%${marker}%`}
      ORDER BY created_at ASC
      LIMIT 1
    `;
    if (existing) return [existing];

    return tx<{ id: string }[]>`
      INSERT INTO tasks (
        hive_id, goal_id, assigned_to, created_by, title, brief,
        priority, qa_required, acceptance_criteria
      ) VALUES (
        ${decision.hive_id},
        ${decision.goal_id},
        'dev-agent',
        'decision-release-scan',
        ${title},
        ${brief},
        3,
        true,
        ${"Approved release-scan decision queues one model-registry patch task; model is selectable in roles, adapter settings, and hive creation dropdowns; role assignment works; dispatcher cost tracker covers the model; implementation is committed and rebuild passes."}
      )
      RETURNING id
    `;
  });

  return task?.id ?? null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const { id } = await params;
    const body = await request.json();
    const { response: rawResponse, comment, rating, selectedOptionKey, selectedOptionLabel } = body as {
      response?: string;
      comment?: string;
      rating?: unknown;
      selectedOptionKey?: unknown;
      selectedOptionLabel?: unknown;
    };
    const requestedOptionKey = typeof selectedOptionKey === "string" && selectedOptionKey.trim()
      ? selectedOptionKey.trim()
      : null;
    const normalisedComment = typeof comment === "string" ? comment.trim() : "";
    if (normalisedComment.length > MAX_RESPONSE_COMMENT_LENGTH) {
      return jsonError(`comment must be ${MAX_RESPONSE_COMMENT_LENGTH} characters or fewer`, 400);
    }
    let response = rawResponse;

    const [decisionForAuth] = await sql<
      {
        hive_id: string;
        kind: string;
        options: unknown;
        route_metadata: unknown;
        status: string;
        owner_response: string | null;
        is_qa_fixture: boolean;
      }[]
    >`
      SELECT hive_id, kind, options, route_metadata, status, owner_response, is_qa_fixture FROM decisions WHERE id = ${id}
    `;
    if (!decisionForAuth) {
      return jsonError("Decision not found", 404);
    }
    if (!user.isSystemOwner) {
      const authorized = decisionForAuth.kind === EXTERNAL_ACTION_APPROVAL_DECISION_KIND
        ? await canMutateHive(sql, user.id, decisionForAuth.hive_id)
        : await canAccessHive(sql, user.id, decisionForAuth.hive_id);
      if (!authorized) {
        return jsonError(
          decisionForAuth.kind === EXTERNAL_ACTION_APPROVAL_DECISION_KIND
            ? "Forbidden: caller cannot approve external actions for this hive"
            : "Forbidden: caller cannot access this hive",
          403,
        );
      }
    }

    let selectedOption: NamedDecisionOption | null = null;
    if (requestedOptionKey) {
      selectedOption = findNamedDecisionOption(decisionForAuth.options, requestedOptionKey);
      if (!selectedOption) {
        return jsonError("Selected option was not found on this decision", 400);
      }
      response = response ?? selectedOption.response ?? (
        decisionForAuth.kind === EXTERNAL_ACTION_APPROVAL_DECISION_KIND
          ? responseForExternalActionOption(selectedOption)
          : null
      ) ?? "approved";
    }

    if (
      !response ||
      (!VALID_RESPONSES.includes(response as ValidResponse) && !isQualityFeedbackResponse(response))
    ) {
      return jsonError(
        `Invalid response. Must be one of: ${[...VALID_RESPONSES, ...QUALITY_FEEDBACK_RESPONSES].join(", ")}`,
        400,
      );
    }

    if (decisionForAuth.kind === EXTERNAL_ACTION_APPROVAL_DECISION_KIND) {
      if (!requestedOptionKey || !selectedOption) {
        return jsonError("External action decisions require selectedOptionKey 'approve' or 'reject'", 400);
      }
      const optionResponse = responseForExternalActionOption(selectedOption);
      if (response !== optionResponse) {
        return jsonError(
          `External action response must match selectedOptionKey '${selectedOption.key}'`,
          400,
        );
      }
    }

    const normalisedRating = normaliseQualityRating(rating);
    if (isQualityFeedbackResponse(response) && !isTaskQualityFeedbackDecision(decisionForAuth)) {
      return jsonError("Quality feedback responses are only valid for task quality feedback decisions", 400);
    }
    if (response === "quality_feedback" && normalisedRating === null) {
      return jsonError("rating must be an integer from 1 to 10", 400);
    }

    let externalActionRequestId: string | null = null;
    if (decisionForAuth.kind === EXTERNAL_ACTION_APPROVAL_DECISION_KIND) {
      const validated = await validateExternalActionDecisionLink(
        id,
        decisionForAuth.hive_id,
        decisionForAuth.route_metadata,
      );
      if (validated instanceof Response) return validated;
      externalActionRequestId = validated;
    }

    const optionLabel = selectedOption?.label ??
      (typeof selectedOptionLabel === "string" && selectedOptionLabel.trim()
        ? selectedOptionLabel.trim()
        : null);
    const ownerResponse = isQualityFeedbackResponse(response)
      ? JSON.stringify({
          response,
          rating: response === "quality_feedback" ? normalisedRating : null,
          comment: normalisedComment || null,
        })
      : normalisedComment
        ? `${response}: ${normalisedComment}`
        : response;

    if (
      response === "approved" &&
      decisionForAuth.status !== "resolved" &&
      typeof decisionForAuth.owner_response === "string" &&
      decisionForAuth.owner_response.startsWith("discussed") &&
      extractReleaseScanModelPayload(decisionForAuth)
    ) {
      return jsonError(
        "Decision was already discussed; create a new decision before approving this release-scan proposal.",
        409,
      );
    }

    if (response !== "discussed" && decisionForAuth.status === "resolved") {
      const existingRows = await sql`
        SELECT id, hive_id, goal_id, title, context, recommendation, options, route_metadata,
               priority, status, kind, owner_response,
               selected_option_key, selected_option_label, created_at, resolved_at,
               task_id, is_qa_fixture
        FROM decisions
        WHERE id = ${id}
      `;
      const existingDecision = existingRows[0] as DecisionRowForModelProposal | undefined;
      const recordedApproval =
        existingDecision?.selected_option_key === "approve" ||
        existingDecision?.owner_response === "approved" ||
        existingDecision?.owner_response?.startsWith("approved:");
      const recordedRejection =
        existingDecision?.selected_option_key === "reject" ||
        existingDecision?.owner_response === "rejected" ||
        existingDecision?.owner_response?.startsWith("rejected:");
      const sameRecordedResponse =
        (response === "approved" && recordedApproval) ||
        (response === "rejected" && recordedRejection);
      if (existingDecision && externalActionRequestId && sameRecordedResponse) {
        const externalActionResult = response === "approved"
          ? await executeApprovedExternalAction(sql, {
              requestId: externalActionRequestId,
              decisionId: id,
              hiveId: decisionForAuth.hive_id,
              actor: user.id,
            })
          : (await rejectExternalAction(sql, {
              requestId: externalActionRequestId,
              decisionId: id,
              hiveId: decisionForAuth.hive_id,
              actor: user.id,
            }), { requestId: externalActionRequestId, status: "rejected" as const });
        return jsonOk({
          id: existingDecision.id,
          hiveId: existingDecision.hive_id,
          goalId: existingDecision.goal_id,
          taskId: existingDecision.task_id,
          title: existingDecision.title,
          context: existingDecision.context,
          recommendation: existingDecision.recommendation,
          options: existingDecision.options,
          kind: existingDecision.kind,
          routeMetadata: existingDecision.route_metadata,
          priority: existingDecision.priority,
          status: existingDecision.status,
          ownerResponse: existingDecision.owner_response,
          selectedOptionKey: existingDecision.selected_option_key,
          selectedOptionLabel: existingDecision.selected_option_label,
          createdAt: existingDecision.created_at,
          resolvedAt: existingDecision.resolved_at,
          queuedTaskId: null,
          learningGateApproval: null,
          externalActionResult,
        });
      }
      if (response === "approved" && recordedApproval && existingDecision) {
        const queuedTaskId = await queueModelRegistryPatchTaskIfNeeded(existingDecision);
        if (queuedTaskId) {
          return jsonOk({
            id: existingDecision.id,
            hiveId: existingDecision.hive_id,
            goalId: existingDecision.goal_id,
            taskId: existingDecision.task_id,
            title: existingDecision.title,
            context: existingDecision.context,
            recommendation: existingDecision.recommendation,
            options: existingDecision.options,
            kind: existingDecision.kind,
            routeMetadata: existingDecision.route_metadata,
            priority: existingDecision.priority,
            status: existingDecision.status,
            ownerResponse: existingDecision.owner_response,
            selectedOptionKey: existingDecision.selected_option_key,
            selectedOptionLabel: existingDecision.selected_option_label,
            createdAt: existingDecision.created_at,
            resolvedAt: existingDecision.resolved_at,
            queuedTaskId,
            learningGateApproval: null,
            externalActionResult: null,
          });
        }
      }
      return jsonError(
        "Decision is already resolved; create a new decision or discussion comment instead of changing the recorded response.",
        409,
      );
    }

    let rows;
    let learningGateApproval = null;
    if (response === "discussed") {
      // Insert discussion message — do NOT resolve the decision
      const [message] = await sql<{ id: string }[]>`
        INSERT INTO decision_messages (decision_id, sender, content)
        VALUES (${id}, 'owner', ${normalisedComment || response})
        RETURNING id
      `;
      await mirrorOwnerDecisionCommentToGoalComment(sql, message.id);
      rows = await sql`
        UPDATE decisions
        SET owner_response = ${ownerResponse},
            selected_option_key = ${selectedOption?.key ?? null},
            selected_option_label = ${optionLabel}
        WHERE id = ${id}
        RETURNING id, hive_id, goal_id, title, context, recommendation, options, route_metadata,
                  priority, status, kind, owner_response,
                  selected_option_key, selected_option_label, created_at, resolved_at,
                  task_id, is_qa_fixture
      `;
    } else if (response === "approved" && decisionForAuth.kind === LEARNING_GATE_FOLLOWUP_DECISION_KIND) {
      const txResult = await sql.begin(async (tx) => {
        const updatedRows = await tx`
          UPDATE decisions
          SET
            status = 'resolved',
            owner_response = ${ownerResponse},
            selected_option_key = ${selectedOption?.key ?? null},
            selected_option_label = ${optionLabel},
            resolved_at = NOW(),
            resolved_by = ${user.id}
          WHERE id = ${id}
            AND status <> 'resolved'
          RETURNING id, hive_id, goal_id, title, context, recommendation, options, route_metadata,
                    priority, status, kind, owner_response,
                    selected_option_key, selected_option_label, created_at, resolved_at,
                    task_id, is_qa_fixture
        `;
        if (updatedRows.length === 0) {
          return { rows: updatedRows, learningGateApproval: null };
        }

        return {
          rows: updatedRows,
          learningGateApproval: await applyApprovedLearningGateFollowup(
            tx,
            updatedRows[0] as DecisionRowForModelProposal,
          ),
        };
      });
      rows = txResult.rows;
      learningGateApproval = txResult.learningGateApproval;
    } else {
      rows = await sql`
        UPDATE decisions
        SET
          status = 'resolved',
          owner_response = ${ownerResponse},
          selected_option_key = ${selectedOption?.key ?? null},
          selected_option_label = ${optionLabel},
          resolved_at = NOW(),
          resolved_by = ${user.id}
        WHERE id = ${id}
          AND status <> 'resolved'
        RETURNING id, hive_id, goal_id, title, context, recommendation, options, route_metadata,
                  priority, status, kind, owner_response,
                  selected_option_key, selected_option_label, created_at, resolved_at,
                  task_id, is_qa_fixture
      `;
    }

    if (rows.length === 0) {
      const [current] = await sql<{ status: string }[]>`
        SELECT status FROM decisions WHERE id = ${id}
      `;
      if (current?.status === "resolved") {
        return jsonError(
          "Decision is already resolved; create a new decision or discussion comment instead of changing the recorded response.",
          409,
        );
      }
      return jsonError("Decision not found", 404);
    }

    if (response !== "discussed") {
      // If this decision was spawned by an escalated insight, propagate the
      // owner's response back to the insight so it doesn't stay 'escalated'
      // forever after the decision is resolved here. The mapping mirrors the
      // two options the curator wrote into decisions.options:
      //   approved  → insight is real, treat as actionable (promote)
      //   rejected  → insight is not actionable (dismiss)
      const [linkedInsight] = await sql`
        SELECT id FROM insights WHERE decision_id = ${id} AND status = 'escalated'
      `;
      if (linkedInsight) {
        const newInsightStatus = response === "approved" ? "actioned" : "dismissed";
        const insightReason = `Resolved via decisions: ${response}` +
          (normalisedComment ? ` (${normalisedComment})` : "");
        if (newInsightStatus === "actioned") {
          // Idempotently promote — the curator may have already done this if
          // somebody hand-set the status earlier, but the standing-instruction
          // row would be missing.
          const [existing] = await sql`
            SELECT id FROM standing_instructions WHERE source_insight_id = ${linkedInsight.id}
          `;
          if (!existing) {
            const { promoteInsightToInstruction } = await import("@/standing-instructions/manager");
            await promoteInsightToInstruction(sql, linkedInsight.id as string);
          }
          await sql`
            UPDATE insights
            SET curator_reason = ${insightReason}, curated_at = NOW(), updated_at = NOW()
            WHERE id = ${linkedInsight.id}
          `;
        } else {
          await sql`
            UPDATE insights
            SET status = 'dismissed',
                curator_reason = ${insightReason},
                curated_at = NOW(),
                updated_at = NOW()
            WHERE id = ${linkedInsight.id}
          `;
        }
      }
    }

    const decisionRow = rows[0] as DecisionRowForModelProposal;
    let externalActionResult: ExecuteExternalActionResult | { requestId: string; status: "rejected" } | null = null;

    if (externalActionRequestId && response === "approved") {
      externalActionResult = await executeApprovedExternalAction(sql, {
        requestId: externalActionRequestId,
        decisionId: id,
        hiveId: decisionForAuth.hive_id,
        actor: user.id,
      });
    } else if (externalActionRequestId && response === "rejected") {
      await rejectExternalAction(sql, {
        requestId: externalActionRequestId,
        decisionId: id,
        hiveId: decisionForAuth.hive_id,
        actor: user.id,
      });
      externalActionResult = { requestId: externalActionRequestId, status: "rejected" };
    }

    if (isDirectTaskQaCapAction(response)) {
      await applyDirectTaskQaCapResponse(decisionRow, response, normalisedComment);
    }

    if (response === "quality_feedback") {
      await applyTaskQualityFeedbackResponse(decisionRow, normalisedRating, normalisedComment);
    }

    const queuedTaskId = response === "approved"
      ? await queueModelRegistryPatchTaskIfNeeded(rows[0] as DecisionRowForModelProposal)
      : null;
    learningGateApproval = response === "approved" && !learningGateApproval
      ? await applyApprovedLearningGateFollowup(sql, rows[0] as DecisionRowForModelProposal)
      : learningGateApproval;

    const r = rows[0] as {
      id: string;
      hive_id: string;
      goal_id: string | null;
      task_id: string | null;
      title: string;
      context: string;
      recommendation: string | null;
      options: unknown;
      kind: string;
      route_metadata: unknown;
      priority: string;
      status: string;
      owner_response: string | null;
      selected_option_key: string | null;
      selected_option_label: string | null;
      created_at: Date;
      resolved_at: Date | null;
    };

    await recordDecisionAuditEvent({
      sql,
      request,
      user,
      eventType: decisionEventForResponse(response),
      decision: r,
      metadata: {
        source: "decision_respond",
        response,
        selectedOptionKey: r.selected_option_key,
        selectedOptionLabelProvided: Boolean(r.selected_option_label),
        commentProvided: Boolean(normalisedComment),
        ratingProvided: normalisedRating !== null,
        queuedTaskId,
        learningGateApproval,
        externalActionResult,
      },
    });

    return jsonOk({
      id: r.id,
      hiveId: r.hive_id,
      goalId: r.goal_id,
      taskId: r.task_id,
      title: r.title,
      context: r.context,
      recommendation: r.recommendation,
      options: r.options,
      kind: r.kind,
      routeMetadata: r.route_metadata,
      priority: r.priority,
      status: r.status,
      ownerResponse: r.owner_response,
      selectedOptionKey: r.selected_option_key,
      selectedOptionLabel: r.selected_option_label,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
      queuedTaskId,
      learningGateApproval,
      externalActionResult,
    });
  } catch {
    return jsonError("Failed to respond to decision", 500);
  }
}
