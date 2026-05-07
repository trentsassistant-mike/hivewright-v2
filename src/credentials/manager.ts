import type { Sql } from "postgres";
import {
  AGENT_AUDIT_EVENTS,
  recordAgentAuditEventBestEffort,
  type AgentAuditContext,
} from "@/audit/agent-events";
import { encrypt, decrypt, createCredentialFingerprint } from "./encryption";

export interface StoreCredentialInput {
  hiveId?: string | null;
  name: string;
  key: string;
  value: string;
  provider?: string;
  baseUrl?: string | null;
  rolesAllowed?: string[];
  expiresAt?: Date | null;
  encryptionKey: string;
}

export interface LoadCredentialsInput {
  hiveId: string;
  /** Credential keys to load. Use `keys` or `requiredKeys` — both are accepted. */
  keys?: string[];
  /** Alias for `keys`. Takes precedence if both are provided. */
  requiredKeys?: string[];
  roleSlug: string;
  encryptionKey: string;
  auditContext?: AgentAuditContext;
}

export interface StoredCredential {
  id: string;
  hiveId: string | null;
  name: string;
  key: string;
  value: string;
  fingerprint: string | null;
  rolesAllowed: string[];
}

export interface BackfillCredentialFingerprintsInput {
  encryptionKey: string;
}

export interface BackfillCredentialFingerprintsResult {
  scanned: number;
  updated: number;
  failed: number;
}

export async function storeCredential(
  sql: Sql,
  input: StoreCredentialInput
): Promise<{ id: string }> {
  const encryptedValue = encrypt(input.value, input.encryptionKey);
  const fingerprint = createCredentialFingerprint({
    provider: input.provider ?? input.key,
    baseUrl: input.baseUrl,
    secretValue: input.value,
  });
  const rolesAllowed = input.rolesAllowed ?? [];

  const [row] = await sql`
    INSERT INTO credentials (hive_id, name, key, value, fingerprint, roles_allowed, expires_at)
    VALUES (
      ${input.hiveId ?? null},
      ${input.name},
      ${input.key},
      ${encryptedValue},
      ${fingerprint},
      ${sql.json(rolesAllowed)},
      ${input.expiresAt ?? null}
    )
    RETURNING id
  `;

  return { id: row.id };
}

export async function loadCredentials(
  sql: Sql,
  input: LoadCredentialsInput & { requiredKeys: string[] }
): Promise<Record<string, string>>;
export async function loadCredentials(
  sql: Sql,
  input: LoadCredentialsInput
): Promise<StoredCredential[]>;
export async function loadCredentials(
  sql: Sql,
  input: LoadCredentialsInput
): Promise<StoredCredential[] | Record<string, string>> {
  const keysToLoad = input.requiredKeys ?? input.keys ?? [];

  const rows = await sql`
    SELECT id, hive_id, name, key, value, fingerprint, roles_allowed
    FROM credentials
    WHERE key = ANY(${keysToLoad})
      AND (hive_id = ${input.hiveId} OR hive_id IS NULL)
  `;

  const results: StoredCredential[] = [];

  for (const row of rows) {
    const rolesAllowed: string[] = row.roles_allowed ?? [];

    // Empty rolesAllowed = accessible by all roles
    // Otherwise check if roleSlug is in the allowed list
    if (rolesAllowed.length > 0 && !rolesAllowed.includes(input.roleSlug)) {
      continue;
    }

    let decryptedValue: string;
    try {
      decryptedValue = decrypt(row.value as string, input.encryptionKey);
      await recordAgentAuditEventBestEffort(sql, {
        ...(input.auditContext ?? {}),
        actor: input.auditContext?.actor ?? { type: "agent", id: input.roleSlug },
        eventType: AGENT_AUDIT_EVENTS.credentialDecryptedForAgentSpawn,
        targetType: "credential",
        targetId: row.id as string,
        outcome: "success",
        metadata: {
          credentialKey: row.key,
          credentialHiveId: row.hive_id,
          roleSlug: input.roleSlug,
          rolesAllowed,
        },
      });
    } catch {
      console.error(`[credentials] Failed to decrypt credential: ${row.key}`);
      await recordAgentAuditEventBestEffort(sql, {
        ...(input.auditContext ?? {}),
        actor: input.auditContext?.actor ?? { type: "agent", id: input.roleSlug },
        eventType: AGENT_AUDIT_EVENTS.credentialDecryptedForAgentSpawn,
        targetType: "credential",
        targetId: row.id as string,
        outcome: "error",
        metadata: {
          credentialKey: row.key,
          credentialHiveId: row.hive_id,
          roleSlug: input.roleSlug,
        },
      });
      continue;
    }

    results.push({
      id: row.id,
      hiveId: row.hive_id,
      name: row.name,
      key: row.key,
      value: decryptedValue,
      fingerprint: row.fingerprint ?? null,
      rolesAllowed,
    });
  }

  // When requiredKeys is used, return a flat Record<string, string> map
  if (input.requiredKeys !== undefined) {
    const record: Record<string, string> = {};
    for (const cred of results) {
      record[cred.key] = cred.value;
    }
    return record;
  }

  return results;
}

export async function backfillCredentialFingerprints(
  sql: Sql,
  input: BackfillCredentialFingerprintsInput,
): Promise<BackfillCredentialFingerprintsResult> {
  const rows = await sql`
    SELECT id, key, value
    FROM credentials
    WHERE fingerprint IS NULL
    ORDER BY created_at ASC, id ASC
  `;

  let updated = 0;
  let failed = 0;

  for (const row of rows) {
    let secretValue: string;
    try {
      secretValue = decrypt(row.value as string, input.encryptionKey);
    } catch {
      failed += 1;
      console.error(`[credentials] Failed to decrypt credential for fingerprint backfill: ${row.id}`);
      continue;
    }

    const fingerprint = createCredentialFingerprint({
      provider: row.key as string,
      baseUrl: null,
      secretValue,
    });

    const updatedRows = await sql`
      UPDATE credentials
      SET fingerprint = ${fingerprint}, updated_at = NOW()
      WHERE id = ${row.id} AND fingerprint IS NULL
      RETURNING id
    `;

    if (updatedRows.length > 0) {
      updated += 1;
    }
  }

  return {
    scanned: rows.length,
    updated,
    failed,
  };
}

/**
 * Hard-delete a credential row. Returns whether a row was actually removed
 * so callers can distinguish 200 (deleted) from 404 (no such id).
 *
 * NB: this is a pure DB op — it does NOT check for connector_installs that
 * reference the credential. The DELETE /api/credentials/[id] route enforces
 * that policy at the API layer (returns 409 unless ?force=true) so the
 * manager stays usable from migrations and admin scripts.
 */
export async function deleteCredential(
  sql: Sql,
  id: string,
): Promise<{ deleted: boolean }> {
  const rows = await sql`DELETE FROM credentials WHERE id = ${id} RETURNING id`;
  return { deleted: rows.length > 0 };
}
