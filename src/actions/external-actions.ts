import { invokeConnector } from "@/connectors/runtime";
import { getConnectorDefinition } from "@/connectors/registry";
import { decrypt, encrypt } from "@/credentials/encryption";
import { evaluateActionPolicy, loadActionPoliciesForHive, type ActionPolicySql } from "./policy";
import { redactActionPayload, sanitizeAuditString } from "./redaction";

export type ExternalActionSql = ActionPolicySql;

export type ExternalActionStatus =
  | "blocked"
  | "awaiting_approval"
  | "approved"
  | "rejected"
  | "executing"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ExternalActionActor {
  type?: "role" | "system" | "owner" | string;
  id?: string;
  roleSlug?: string | null;
}

export interface RequestExternalActionInput {
  hiveId: string;
  installId: string;
  operation: string;
  args?: Record<string, unknown>;
  actor: ExternalActionActor | string;
  taskId?: string | null;
  goalId?: string | null;
  idempotencyKey?: string | null;
}

export interface RequestExternalActionResult {
  requestId: string;
  decisionId?: string;
  status: ExternalActionStatus;
  policyDecision: "allow" | "require_approval" | "block";
  policyReason: string;
  connectorSlug: string;
  operation: string;
  result?: unknown;
  error?: string;
}

export interface ExecuteExternalActionInput {
  requestId: string;
  decisionId?: string;
  hiveId?: string;
  actor?: ExternalActionActor | string;
}

export interface ExecuteExternalActionResult {
  requestId: string;
  status: ExternalActionStatus;
  result?: unknown;
  error?: string;
}

interface ConnectorInstallRow {
  id: string;
  hive_id: string;
  connector_slug: string;
  status: string;
}

interface ExternalActionRequestRow {
  id: string;
  hive_id: string;
  task_id?: string | null;
  goal_id?: string | null;
  decision_id?: string | null;
  connector: string;
  operation: string;
  role_slug?: string | null;
  state: ExternalActionStatus;
  idempotency_key?: string | null;
  request_payload: Record<string, unknown>;
  response_payload?: Record<string, unknown> | null;
  policy_id?: string | null;
  policy_snapshot: Record<string, unknown>;
  execution_metadata?: Record<string, unknown> | null;
  encrypted_execution_payload?: string | null;
  error_message?: string | null;
}

interface DecisionRow {
  id: string;
  hive_id: string;
  status: string;
  selected_option_key?: string | null;
}

function actorLabel(actor: ExternalActionActor | string | undefined): string {
  if (!actor) return "system";
  if (typeof actor === "string") return actor;
  return actor.id ?? actor.roleSlug ?? actor.type ?? "system";
}

function actorRoleSlug(actor: ExternalActionActor | string | undefined): string | null {
  if (!actor || typeof actor === "string") return null;
  return actor.roleSlug ?? (actor.type === "role" ? actor.id ?? null : null);
}

function encryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY ?? "";
  if (!key) throw new Error("ENCRYPTION_KEY is not configured for external action execution payloads");
  return key;
}

function encryptExecutionArgs(args: Record<string, unknown>): string {
  return encrypt(JSON.stringify({ args }), encryptionKey());
}

function decryptExecutionArgs(encryptedPayload: string): Record<string, unknown> {
  const decoded = JSON.parse(decrypt(encryptedPayload, encryptionKey())) as { args?: Record<string, unknown> };
  return decoded.args ?? {};
}

function sanitizeErrorMessage(error: string | undefined): string {
  if (!error) return "connector invocation failed";
  return sanitizeAuditString(error);
}

async function runInTransaction<T>(sql: ExternalActionSql, fn: (tx: ExternalActionSql) => Promise<T>): Promise<T> {
  const candidate = sql as unknown as { begin?: (cb: (tx: ExternalActionSql) => Promise<T>) => Promise<T> };
  return candidate.begin ? candidate.begin(fn) : fn(sql);
}

function toStatus(row: ExternalActionRequestRow): ExternalActionStatus {
  return row.state;
}

function existingRequestResult(row: ExternalActionRequestRow): RequestExternalActionResult {
  const snapshot = row.policy_snapshot ?? {};
  return {
    requestId: row.id,
    decisionId: row.decision_id ?? undefined,
    status: toStatus(row),
    policyDecision: (snapshot.decision as RequestExternalActionResult["policyDecision"]) ?? "require_approval",
    policyReason: (snapshot.reason as string) ?? "existing external action request",
    connectorSlug: row.connector,
    operation: row.operation,
    result: row.response_payload,
    error: row.error_message ?? undefined,
  };
}

async function loadConnectorInstallById(
  sql: ExternalActionSql,
  hiveId: string,
  installId: string,
): Promise<ConnectorInstallRow> {
  const [install] = (await sql`
    SELECT id, hive_id, connector_slug, status
    FROM connector_installs
    WHERE id = ${installId}
      AND hive_id = ${hiveId}::uuid
    LIMIT 1
  `) as unknown as ConnectorInstallRow[];
  if (!install) throw new Error(`connector install ${installId} not found for hive ${hiveId}`);
  if (install.status !== "active") throw new Error(`connector install ${installId} is ${install.status}`);
  return install;
}

async function findExistingIdempotentRequest(
  sql: ExternalActionSql,
  hiveId: string,
  idempotencyKey?: string | null,
): Promise<ExternalActionRequestRow | null> {
  if (!idempotencyKey) return null;
  const [row] = (await sql`
    SELECT *
    FROM external_action_requests
    WHERE hive_id = ${hiveId}::uuid
      AND idempotency_key = ${idempotencyKey}
    ORDER BY created_at ASC
    LIMIT 1
  `) as unknown as ExternalActionRequestRow[];
  return row ?? null;
}

async function insertExternalActionRequest(
  sql: ExternalActionSql,
  input: RequestExternalActionInput,
  connectorSlug: string,
  effectType: string,
  decision: RequestExternalActionResult["policyDecision"],
  policyReason: string,
  policyId?: string,
): Promise<ExternalActionRequestRow> {
  const roleSlug = actorRoleSlug(input.actor);
  const requestPayload = redactActionPayload({ args: input.args ?? {} });
  const policySnapshot = {
    decision,
    reason: policyReason,
    policyId: policyId ?? null,
    connectorSlug,
    operation: input.operation,
    effectType,
  };
  const executionMetadata = {
    installId: input.installId,
    requestedAt: new Date().toISOString(),
  };
  const encryptedExecutionPayload = decision === "block" ? null : encryptExecutionArgs(input.args ?? {});
  const initialState: ExternalActionStatus = decision === "block"
    ? "blocked"
    : decision === "allow"
      ? "approved"
      : "awaiting_approval";

  const [row] = (await sql`
    INSERT INTO external_action_requests (
      hive_id,
      task_id,
      goal_id,
      connector,
      operation,
      role_slug,
      state,
      idempotency_key,
      request_payload,
      policy_id,
      policy_snapshot,
      execution_metadata,
      encrypted_execution_payload,
      requested_by
    ) VALUES (
      ${input.hiveId}::uuid,
      ${input.taskId ?? null}::uuid,
      ${input.goalId ?? null}::uuid,
      ${connectorSlug},
      ${input.operation},
      ${roleSlug},
      ${initialState},
      ${input.idempotencyKey ?? null},
      ${sql.json(requestPayload as never)},
      ${policyId ?? null}::uuid,
      ${sql.json(policySnapshot as never)},
      ${sql.json(executionMetadata as never)},
      ${encryptedExecutionPayload},
      ${actorLabel(input.actor)}
    )
    ON CONFLICT (hive_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING *
  `) as unknown as ExternalActionRequestRow[];
  if (!row) {
    const existing = await findExistingIdempotentRequest(sql, input.hiveId, input.idempotencyKey);
    if (existing) return existing;
    throw new Error("external action request insert returned no row");
  }
  return row;
}

async function updateExecutionResult(
  sql: ExternalActionSql,
  requestId: string,
  result: Awaited<ReturnType<typeof invokeConnector>>,
): Promise<ExternalActionRequestRow> {
  const state: ExternalActionStatus = result.success ? "succeeded" : "failed";
  const responsePayload = redactActionPayload(
    result.success
      ? (result.data as Record<string, unknown> ?? {})
      : { error: sanitizeErrorMessage(result.error), data: result.data },
  ) as Record<string, unknown>;
  const [row] = (await sql`
    UPDATE external_action_requests
    SET state = ${state},
        response_payload = ${sql.json(responsePayload as never)},
        error_message = ${result.success ? null : sanitizeErrorMessage(result.error)},
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${requestId}
    RETURNING *
  `) as unknown as ExternalActionRequestRow[];
  return row;
}

async function markExecutionFailed(
  sql: ExternalActionSql,
  requestId: string,
  message: string,
): Promise<ExternalActionRequestRow> {
  const responsePayload = redactActionPayload({ error: message }) as Record<string, unknown>;
  const [row] = (await sql`
    UPDATE external_action_requests
    SET state = 'failed',
        response_payload = ${sql.json(responsePayload as never)},
        error_message = ${message},
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${requestId}
    RETURNING *
  `) as unknown as ExternalActionRequestRow[];
  return row;
}

async function claimRequestForExecution(
  sql: ExternalActionSql,
  requestId: string,
  actor: ExternalActionActor | string | undefined,
): Promise<ExternalActionRequestRow> {
  const [row] = (await sql`
    UPDATE external_action_requests
    SET state = 'executing', reviewed_at = NOW(), reviewed_by = ${actorLabel(actor)}, executed_at = NOW(), updated_at = NOW()
    WHERE id = ${requestId}
      AND state IN ('awaiting_approval', 'approved')
    RETURNING *
  `) as unknown as ExternalActionRequestRow[];
  if (!row) throw new Error(`external action request ${requestId} could not be claimed for execution`);
  return row;
}

async function executeRequestRow(
  sql: ExternalActionSql,
  row: ExternalActionRequestRow,
  installId: string,
  actor: ExternalActionActor | string | undefined,
  argsOverride?: Record<string, unknown>,
): Promise<ExecuteExternalActionResult> {
  let args: Record<string, unknown>;
  try {
    if (argsOverride) {
      args = argsOverride;
    } else if (row.encrypted_execution_payload) {
      args = decryptExecutionArgs(row.encrypted_execution_payload);
    } else {
      throw new Error(`external action request ${row.id} is missing encrypted execution payload`);
    }
  } catch (error) {
    const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
    const failed = await markExecutionFailed(sql, row.id, message);
    return {
      requestId: row.id,
      status: failed.state,
      result: failed.response_payload ?? undefined,
      error: failed.error_message ?? undefined,
    };
  }

  try {
    const result = await invokeConnector(sql as never, {
      installId,
      operation: row.operation,
      args,
      actor: actorLabel(actor),
    });
    const updated = await updateExecutionResult(sql, row.id, result);
    return {
      requestId: row.id,
      status: updated.state,
      result: updated.response_payload,
      error: updated.error_message ?? undefined,
    };
  } catch (error) {
    const message = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
    const failed = await markExecutionFailed(sql, row.id, message);
    return {
      requestId: row.id,
      status: failed.state,
      result: failed.response_payload ?? undefined,
      error: failed.error_message ?? undefined,
    };
  }
}

export async function requestExternalAction(
  sql: ExternalActionSql,
  input: RequestExternalActionInput,
): Promise<RequestExternalActionResult> {
  const existing = await findExistingIdempotentRequest(sql, input.hiveId, input.idempotencyKey);
  if (existing) {
    const decision = (existing.policy_snapshot?.decision as string | undefined) ?? "require_approval";
    if (decision === "allow" && ["approved", "awaiting_approval"].includes(existing.state)) {
      const installId = String((existing.execution_metadata ?? {}).installId ?? input.installId ?? "");
      const executingRow = await claimRequestForExecution(sql, existing.id, input.actor);
      const execution = await executeRequestRow(sql, executingRow, installId, input.actor);
      return {
        ...existingRequestResult(existing),
        status: execution.status,
        result: execution.result,
        error: execution.error,
      };
    }
    return existingRequestResult(existing);
  }

  const install = await loadConnectorInstallById(sql, input.hiveId, input.installId);
  const definition = getConnectorDefinition(install.connector_slug);
  if (!definition) throw new Error(`unknown connector ${install.connector_slug}`);
  const operation = definition.operations.find((candidate) => candidate.slug === input.operation);
  if (!operation) throw new Error(`operation ${input.operation} not supported by ${definition.slug}`);

  const policies = await loadActionPoliciesForHive(sql, input.hiveId);
  const policy = evaluateActionPolicy({
    hiveId: input.hiveId,
    connectorSlug: definition.slug,
    operation: input.operation,
    effectType: operation.governance.effectType,
    defaultDecision: operation.governance.defaultDecision,
    actorRoleSlug: actorRoleSlug(input.actor),
    args: input.args,
    policies,
  });

  if (policy.decision === "require_approval") {
    return runInTransaction(sql, async (tx) => {
      const request = await insertExternalActionRequest(
        tx,
        input,
        definition.slug,
        operation.governance.effectType,
        policy.decision,
        policy.reason,
        policy.policyId,
      );
      if (request.decision_id) return existingRequestResult(request);

      const [decision] = (await tx`
        INSERT INTO decisions (
          hive_id,
          goal_id,
          task_id,
          title,
          context,
          recommendation,
          options,
          priority,
          status,
          kind,
          route_metadata
        ) VALUES (
          ${input.hiveId}::uuid,
          ${input.goalId ?? null}::uuid,
          ${input.taskId ?? null}::uuid,
          ${`Approve ${definition.name} ${operation.label}?`},
          ${`External action request ${request.id} wants to run ${definition.slug}.${input.operation}. Policy: ${policy.reason}`},
          ${"Approve only if this external side effect is expected."},
          ${tx.json([
            { key: "approve", label: "Approve", consequence: "Execute the external action once." },
            { key: "reject", label: "Reject", consequence: "Do not execute the external action." },
          ])},
          ${"normal"},
          ${"pending"},
          ${"external_action_approval"},
          ${tx.json({ externalActionRequestId: request.id, connectorSlug: definition.slug, operation: input.operation })}
        )
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      const [updated] = (await tx`
        UPDATE external_action_requests
        SET decision_id = ${decision.id}, state = ${"awaiting_approval"}, updated_at = NOW()
        WHERE id = ${request.id}
        RETURNING *
      `) as unknown as ExternalActionRequestRow[];
      return {
        requestId: request.id,
        decisionId: decision.id,
        status: updated.state,
        policyDecision: policy.decision,
        policyReason: policy.reason,
        connectorSlug: definition.slug,
        operation: input.operation,
      };
    });
  }

  const request = await insertExternalActionRequest(
    sql,
    input,
    definition.slug,
    operation.governance.effectType,
    policy.decision,
    policy.reason,
    policy.policyId,
  );

  if (policy.decision === "block") {
    return {
      requestId: request.id,
      status: "blocked",
      policyDecision: policy.decision,
      policyReason: policy.reason,
      connectorSlug: definition.slug,
      operation: input.operation,
    };
  }

  const executingRow = await claimRequestForExecution(sql, request.id, input.actor);
  const execution = await executeRequestRow(sql, executingRow, input.installId, input.actor);
  return {
    requestId: request.id,
    status: execution.status,
    policyDecision: policy.decision,
    policyReason: policy.reason,
    connectorSlug: definition.slug,
    operation: input.operation,
    result: execution.result,
    error: execution.error,
  };
}

function decisionApproved(decision: DecisionRow): boolean {
  return decision.status === "resolved" && decision.selected_option_key === "approve";
}

export async function executeApprovedExternalAction(
  sql: ExternalActionSql,
  input: ExecuteExternalActionInput,
): Promise<ExecuteExternalActionResult> {
  const [request] = (await sql`
    SELECT *
    FROM external_action_requests
    WHERE id = ${input.requestId}
      AND (${input.hiveId ?? null}::uuid IS NULL OR hive_id = ${input.hiveId ?? null}::uuid)
      AND (${input.decisionId ?? null}::uuid IS NULL OR decision_id = ${input.decisionId ?? null}::uuid)
    LIMIT 1
  `) as unknown as ExternalActionRequestRow[];
  if (!request) throw new Error(`external action request ${input.requestId} not found`);

  if (["succeeded", "failed", "rejected", "blocked", "cancelled"].includes(request.state)) {
    return {
      requestId: request.id,
      status: request.state,
      result: request.response_payload ?? undefined,
      error: request.error_message ?? undefined,
    };
  }

  if (!request.decision_id) throw new Error(`external action request ${request.id} has no approval decision`);
  const [decision] = (await sql`
    SELECT id, hive_id, status, selected_option_key
    FROM decisions
    WHERE id = ${request.decision_id}
      AND hive_id = ${request.hive_id}::uuid
    LIMIT 1
  `) as unknown as DecisionRow[];
  if (!decision || !decisionApproved(decision)) {
    throw new Error(`external action request ${request.id} is not approved`);
  }

  const [claim] = (await sql`
    UPDATE external_action_requests
    SET state = 'executing', reviewed_at = NOW(), reviewed_by = ${actorLabel(input.actor)}, executed_at = NOW(), updated_at = NOW()
    WHERE id = ${request.id}
      AND state IN ('awaiting_approval', 'approved')
    RETURNING *
  `) as unknown as ExternalActionRequestRow[];

  if (!claim) {
    const [current] = (await sql`
      SELECT *
      FROM external_action_requests
      WHERE id = ${request.id}
      LIMIT 1
    `) as unknown as ExternalActionRequestRow[];
    return {
      requestId: request.id,
      status: current?.state ?? request.state,
      result: current?.response_payload ?? undefined,
      error: current?.error_message ?? undefined,
    };
  }

  const installId = String((claim.execution_metadata ?? {}).installId ?? "");
  if (!installId) {
    const failed = await markExecutionFailed(
      sql,
      claim.id,
      sanitizeErrorMessage(`external action request ${request.id} is missing installId metadata`),
    );
    return {
      requestId: request.id,
      status: failed.state,
      result: failed.response_payload ?? undefined,
      error: failed.error_message ?? undefined,
    };
  }
  return executeRequestRow(sql, claim, installId, input.actor);
}

export async function rejectExternalAction(
  sql: ExternalActionSql,
  input: ExecuteExternalActionInput,
): Promise<void> {
  await sql`
    UPDATE external_action_requests
    SET state = 'rejected', reviewed_at = NOW(), reviewed_by = ${actorLabel(input.actor)}, updated_at = NOW()
    WHERE id = ${input.requestId}
      AND (${input.hiveId ?? null}::uuid IS NULL OR hive_id = ${input.hiveId ?? null}::uuid)
      AND (${input.decisionId ?? null}::uuid IS NULL OR decision_id = ${input.decisionId ?? null}::uuid)
      AND state IN ('awaiting_approval', 'approved', 'proposed')
    RETURNING *
  `;
}
