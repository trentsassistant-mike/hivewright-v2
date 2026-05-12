import type { Sql } from "postgres";
import { createHash } from "node:crypto";
import {
  AGENT_AUDIT_EVENTS,
  recordAgentAuditEventBestEffort,
  type AgentAuditContext,
} from "@/audit/agent-events";
import { sanitizeAuditString } from "@/actions/redaction";
import { decrypt } from "../credentials/encryption";
import { HttpWebhookBlockedError } from "./http-webhook-safety";
import { getConnectorDefinition } from "./registry";
import { freshAccessTokenFor } from "./oauth";

/**
 * Look up an installed connector by (hiveId, slug) and return its resolved
 * config + decrypted secrets. Returns `null` if no active install exists.
 *
 * This is the read-side companion to `invokeConnector` — used by endpoints
 * like `/api/voice/token` that need to read secrets/config without running
 * an operation handler. It intentionally skips the event-log + last_error
 * bookkeeping that `invokeConnector` does, since no operation is invoked.
 */
export async function loadConnectorInstall(
  sql: Sql,
  hiveId: string,
  connectorSlug: string,
  auditContext?: AgentAuditContext,
): Promise<{
  installId: string;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
} | null> {
  const [install] = await sql`
    SELECT id, connector_slug, config, credential_id, status
    FROM connector_installs
    WHERE hive_id = ${hiveId}::uuid
      AND connector_slug = ${connectorSlug}
      AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (!install) return null;

  const def = getConnectorDefinition(install.connector_slug as string);
  if (!def) return null;

  const secrets: Record<string, string> = {};
  if (install.credential_id) {
    const [cred] = await sql`
      SELECT value FROM credentials WHERE id = ${install.credential_id}
    `;
    if (cred) {
      const encryptionKey = process.env.ENCRYPTION_KEY || "";
      await recordAgentAuditEventBestEffort(sql, {
        ...(auditContext ?? {}),
        actor: auditContext?.actor ?? { type: "system", id: "connector-runtime" },
        eventType: AGENT_AUDIT_EVENTS.encryptionKeyAccessed,
        hiveId,
        targetType: "encryption_key",
        targetId: "ENCRYPTION_KEY",
        outcome: "success",
        metadata: {
          purpose: "connector_install_secret_decryption",
          connectorSlug,
          installId: install.id,
          credentialId: install.credential_id,
        },
      });
      const blob = decrypt(cred.value as string, encryptionKey);
      const parsed = JSON.parse(blob) as Record<string, unknown>;
      for (const k of def.secretFields) {
        if (typeof parsed[k] === "string") secrets[k] = parsed[k] as string;
      }
      await recordAgentAuditEventBestEffort(sql, {
        ...(auditContext ?? {}),
        actor: auditContext?.actor ?? { type: "system", id: "connector-runtime" },
        eventType: AGENT_AUDIT_EVENTS.connectorTokenUsed,
        hiveId,
        targetType: "connector_install",
        targetId: install.id as string,
        outcome: "success",
        metadata: {
          purpose: "connector_install_secret_load",
          connectorSlug,
          credentialId: install.credential_id,
          secretFields: def.secretFields,
        },
      });
    }
  }

  return {
    installId: install.id as string,
    config: (install.config as Record<string, unknown>) ?? {},
    secrets,
  };
}

/**
 * Invoke an operation on an installed connector.
 *
 * Audit-logs every call to `connector_events` (including failures and
 * lookup errors). Never throws past the function boundary — a failure
 * returns `{ success: false, error }` so call-sites can handle it without
 * cluttering every invocation with try/catch.
 */
export interface InvokeResult {
  success: boolean;
  data?: unknown;
  error?: string;
  durationMs: number;
}

export interface InvokeInput {
  installId: string;
  operation: string;
  args?: Record<string, unknown>;
  actor?: string; // role slug or 'system'
  auditContext?: AgentAuditContext;
  approvedExternalActionRequestId?: string;
  idempotencyKey?: string | null;
}

export function canonicalConnectorPayloadHash(args: Record<string, unknown> | undefined): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !key.startsWith("_"))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalize(nested)]));
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(args ?? {}))).digest("hex");
}

function operationCanRunDirectly(op: { slug: string; governance: { effectType: string; defaultDecision: string } }): boolean {
  if (op.governance.effectType === "read") return op.governance.defaultDecision === "allow";
  if (op.governance.effectType !== "system") return false;
  return ["test_connection", "self_test"].includes(op.slug) && op.governance.defaultDecision === "allow";
}

export async function invokeConnector(
  sql: Sql,
  input: InvokeInput,
): Promise<InvokeResult> {
  const started = Date.now();
  const actor = input.actor ?? "system";

  const [install] = await sql`
    SELECT id, hive_id, connector_slug, display_name, config, credential_id, status, granted_scopes
    FROM connector_installs
    WHERE id = ${input.installId}
  `;
  if (!install) {
    return logAndReturn(sql, null, input.operation, actor, started, {
      success: false,
      error: `install ${input.installId} not found`,
    });
  }
  if (install.status !== "active") {
    return logAndReturn(sql, install.id as string, input.operation, actor, started, {
      success: false,
      error: `install is ${install.status}`,
    });
  }

  const def = getConnectorDefinition(install.connector_slug as string);
  if (!def) {
    return logAndReturn(sql, install.id as string, input.operation, actor, started, {
      success: false,
      error: `unknown connector ${install.connector_slug}`,
    });
  }

  const op = def.operations.find((o) => o.slug === input.operation);
  if (!op) {
    return logAndReturn(sql, install.id as string, input.operation, actor, started, {
      success: false,
      error: `operation ${input.operation} not supported by ${def.slug}`,
    });
  }

  const requiredScopes = op.governance.scopes ?? [];
  if (requiredScopes.length > 0) {
    const grantedScopes = Array.isArray(install.granted_scopes) ? install.granted_scopes as unknown[] : [];
    const grantedScopeSet = new Set(grantedScopes.filter((scope): scope is string => typeof scope === "string"));
    const missingScope = requiredScopes.find((scope) => !grantedScopeSet.has(scope));
    if (missingScope) {
      return logAndReturn(sql, install.id as string, input.operation, actor, started, {
        success: false,
        error: `operation ${def.slug}.${op.slug} requires ungranted connector scope ${missingScope}`,
      });
    }
  }

  const argsForHash = input.args ?? {};
  const directAllowed = operationCanRunDirectly(op);
  if (!directAllowed) {
    if (!input.approvedExternalActionRequestId) {
      return logAndReturn(sql, install.id as string, input.operation, actor, started, {
        success: false,
        error: `operation ${def.slug}.${op.slug} requires an approved external action request`,
      });
    }
    const expectedHash = canonicalConnectorPayloadHash(argsForHash);
    const [request] = await sql`
      SELECT id
      FROM external_action_requests
      WHERE id = ${input.approvedExternalActionRequestId}
        AND hive_id = ${install.hive_id}::uuid
        AND connector = ${def.slug}
        AND operation = ${op.slug}
        AND state IN ('approved', 'executing')
        AND request_payload_hash = ${expectedHash}
        AND (${input.idempotencyKey ?? null}::text IS NULL OR idempotency_key = ${input.idempotencyKey ?? null})
      LIMIT 1
    `;
    if (!request) {
      return logAndReturn(sql, install.id as string, input.operation, actor, started, {
        success: false,
        error: `approved external action request does not match ${def.slug}.${op.slug}`,
      });
    }
  }

  // Decrypt the credential payload, if one is attached.
  const secrets: Record<string, string> = {};
  const args: Record<string, unknown> = { ...(input.args ?? {}) };

  if (def.authType === "oauth2" && install.credential_id) {
    try {
      await recordAgentAuditEventBestEffort(sql, {
        ...(input.auditContext ?? {}),
        actor: input.auditContext?.actor ?? { type: "agent", id: actor },
        eventType: AGENT_AUDIT_EVENTS.encryptionKeyAccessed,
        hiveId: install.hive_id as string,
        targetType: "encryption_key",
        targetId: "ENCRYPTION_KEY",
        outcome: "success",
        metadata: {
          purpose: "oauth_connector_token_refresh",
          connectorSlug: def.slug,
          installId: install.id,
          operation: input.operation,
          credentialId: install.credential_id,
        },
      });
      args._accessToken = await freshAccessTokenFor(sql, install.id as string, def);
      await recordAgentAuditEventBestEffort(sql, {
        ...(input.auditContext ?? {}),
        actor: input.auditContext?.actor ?? { type: "agent", id: actor },
        eventType: AGENT_AUDIT_EVENTS.connectorTokenUsed,
        hiveId: install.hive_id as string,
        targetType: "connector_install",
        targetId: install.id as string,
        outcome: "success",
        metadata: {
          connectorSlug: def.slug,
          operation: input.operation,
          credentialId: install.credential_id,
          authType: def.authType,
        },
      });
    } catch (e) {
      return logAndReturn(sql, install.id as string, input.operation, actor, started, {
        success: false,
        error: `oauth token unavailable: ${(e as Error).message}`,
      });
    }
  } else if (install.credential_id) {
    const [cred] = await sql`
      SELECT value FROM credentials WHERE id = ${install.credential_id}
    `;
    if (cred) {
      const encryptionKey = process.env.ENCRYPTION_KEY || "";
      try {
        await recordAgentAuditEventBestEffort(sql, {
          ...(input.auditContext ?? {}),
          actor: input.auditContext?.actor ?? { type: "agent", id: actor },
          eventType: AGENT_AUDIT_EVENTS.encryptionKeyAccessed,
          hiveId: install.hive_id as string,
          targetType: "encryption_key",
          targetId: "ENCRYPTION_KEY",
          outcome: "success",
          metadata: {
            purpose: "connector_secret_decryption",
            connectorSlug: def.slug,
            installId: install.id,
            operation: input.operation,
            credentialId: install.credential_id,
          },
        });
        const blob = decrypt(cred.value as string, encryptionKey);
        // The credential value stores the secret fields as JSON so the
        // runtime can pass the whole map to the handler (matches how
        // setupFields declare multiple secrets).
        const parsed = JSON.parse(blob);
        for (const k of def.secretFields) {
          if (typeof parsed[k] === "string") secrets[k] = parsed[k];
        }
        await recordAgentAuditEventBestEffort(sql, {
          ...(input.auditContext ?? {}),
          actor: input.auditContext?.actor ?? { type: "agent", id: actor },
          eventType: AGENT_AUDIT_EVENTS.connectorTokenUsed,
          hiveId: install.hive_id as string,
          targetType: "connector_install",
          targetId: install.id as string,
          outcome: "success",
          metadata: {
            connectorSlug: def.slug,
            operation: input.operation,
            credentialId: install.credential_id,
            authType: def.authType,
            secretFields: def.secretFields,
          },
        });
      } catch (e) {
        await recordAgentAuditEventBestEffort(sql, {
          ...(input.auditContext ?? {}),
          actor: input.auditContext?.actor ?? { type: "agent", id: actor },
          eventType: AGENT_AUDIT_EVENTS.connectorTokenUsed,
          hiveId: install.hive_id as string,
          targetType: "connector_install",
          targetId: install.id as string,
          outcome: "error",
          metadata: {
            connectorSlug: def.slug,
            operation: input.operation,
            credentialId: install.credential_id,
            authType: def.authType,
          },
        });
        return logAndReturn(
          sql,
          install.id as string,
          input.operation,
          actor,
          started,
          {
            success: false,
            error: `failed to decrypt credential: ${(e as Error).message}`,
          },
        );
      }
    }
  }

  try {
    const data = await op.handler({
      config: (install.config as Record<string, unknown>) ?? {},
      secrets,
      args,
    });
    await recordHttpWebhookPostAudit(sql, input, install, actor, secrets.url, "success");
    return logAndReturn(sql, install.id as string, input.operation, actor, started, {
      success: true,
      data,
    });
  } catch (e) {
    const outcome = e instanceof HttpWebhookBlockedError ? "blocked" : "error";
    await recordHttpWebhookPostAudit(sql, input, install, actor, secrets.url, outcome, e);
    return logAndReturn(sql, install.id as string, input.operation, actor, started, {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export async function invokeConnectorReadOnlyOrSystem(
  sql: Sql,
  input: InvokeInput,
): Promise<InvokeResult> {
  const { approvedExternalActionRequestId: _approvedExternalActionRequestId, ...directInput } = input;
  void _approvedExternalActionRequestId;
  return invokeConnector(sql, directInput);
}

export async function invokeConnectorGoverned(
  sql: Sql,
  input: InvokeInput,
): Promise<InvokeResult> {
  return invokeConnector(sql, input);
}

export async function executeApprovedConnectorAction(
  sql: Sql,
  input: InvokeInput & { approvedExternalActionRequestId: string },
): Promise<InvokeResult> {
  return invokeConnector(sql, input);
}

async function recordHttpWebhookPostAudit(
  sql: Sql,
  input: InvokeInput,
  install: Record<string, unknown>,
  actor: string,
  targetUrl: string | undefined,
  outcome: "success" | "blocked" | "error",
  error?: unknown,
): Promise<void> {
  if (install.connector_slug !== "http-webhook" || input.operation !== "post_json") {
    return;
  }

  await recordAgentAuditEventBestEffort(sql, {
    ...(input.auditContext ?? {}),
    actor: input.auditContext?.actor ?? { type: "agent", id: actor },
    eventType: AGENT_AUDIT_EVENTS.httpWebhookPost,
    hiveId: install.hive_id as string,
    targetType: "url",
    targetId: targetUrl ? sanitizeAuditString(targetUrl) : null,
    outcome,
    metadata: {
      connectorSlug: "http-webhook",
      installId: install.id,
      operation: input.operation,
      error: error instanceof Error ? sanitizeAuditString(error.message) : error ? sanitizeAuditString(String(error)) : undefined,
    },
  });
}

async function logAndReturn(
  sql: Sql,
  installId: string | null,
  operation: string,
  actor: string,
  started: number,
  partial: Omit<InvokeResult, "durationMs">,
): Promise<InvokeResult> {
  const durationMs = Date.now() - started;
  if (installId) {
    try {
      await sql`
        INSERT INTO connector_events (install_id, operation, status, duration_ms, error_text, actor)
        VALUES (
          ${installId},
          ${operation},
          ${partial.success ? "success" : "error"},
          ${durationMs},
          ${partial.error ? sanitizeAuditString(partial.error) : null},
          ${actor}
        )
      `;
      if (!partial.success) {
        await sql`
          UPDATE connector_installs
          SET last_error = ${partial.error ? sanitizeAuditString(partial.error) : null}, updated_at = NOW()
          WHERE id = ${installId}
        `;
      } else {
        await sql`
          UPDATE connector_installs
          SET last_tested_at = NOW(), last_error = NULL, updated_at = NOW()
          WHERE id = ${installId}
        `;
      }
    } catch {
      // Never let event-logging failures propagate.
    }
  }
  return { ...partial, durationMs };
}
