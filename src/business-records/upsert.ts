import type { Sql, TransactionSql } from "postgres";
import { redactActionPayload } from "@/actions/redaction";

export type BusinessRecordSql = Sql | TransactionSql;

export interface UpsertBusinessRecordInput {
  hiveId: string;
  connectorInstallId?: string | null;
  sourceConnector: string;
  externalId: string;
  recordType: string;
  status?: string | null;
  title?: string | null;
  occurredAt?: Date | string | null;
  amountCents?: number | null;
  currency?: string | null;
  counterparty?: string | null;
  normalized?: Record<string, unknown>;
  rawPayload?: Record<string, unknown>;
}

export interface BusinessRecordResult {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

const MAX_JSON_PAYLOAD_BYTES = 200_000;

export async function upsertBusinessRecord(
  sql: BusinessRecordSql,
  input: UpsertBusinessRecordInput,
): Promise<BusinessRecordResult> {
  const sourceConnector = required(input.sourceConnector, "sourceConnector");
  const externalId = required(input.externalId, "externalId");
  const recordType = required(input.recordType, "recordType");
  const normalized = input.normalized ?? {};
  const rawRedacted = redactActionPayload(input.rawPayload ?? {}) as Record<string, unknown>;

  assertJsonPayloadSize(normalized, "normalized");
  assertJsonPayloadSize(rawRedacted, "rawPayload");

  const [row] = await sql<{
    id: string;
    created_at: Date;
    updated_at: Date;
  }[]>`
    INSERT INTO business_records (
      hive_id,
      connector_install_id,
      source_connector,
      external_id,
      record_type,
      status,
      title,
      occurred_at,
      amount_cents,
      currency,
      counterparty,
      normalized,
      raw_redacted,
      updated_at
    ) VALUES (
      ${input.hiveId}::uuid,
      ${input.connectorInstallId ?? null}::uuid,
      ${sourceConnector},
      ${externalId},
      ${recordType},
      ${input.status ?? null},
      ${input.title ?? null},
      ${input.occurredAt ? new Date(input.occurredAt) : null},
      ${input.amountCents ?? null},
      ${input.currency ?? null},
      ${input.counterparty ?? null},
      ${sql.json(normalized as never)},
      ${sql.json(rawRedacted as never)},
      NOW()
    )
    ON CONFLICT (hive_id, source_connector, external_id, record_type)
    DO UPDATE SET
      connector_install_id = EXCLUDED.connector_install_id,
      status = EXCLUDED.status,
      title = EXCLUDED.title,
      occurred_at = EXCLUDED.occurred_at,
      amount_cents = EXCLUDED.amount_cents,
      currency = EXCLUDED.currency,
      counterparty = EXCLUDED.counterparty,
      normalized = EXCLUDED.normalized,
      raw_redacted = EXCLUDED.raw_redacted,
      updated_at = NOW()
    RETURNING id, created_at, updated_at
  `;

  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function required(value: string | undefined, field: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

function assertJsonPayloadSize(value: Record<string, unknown>, label: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > MAX_JSON_PAYLOAD_BYTES) {
    throw new Error(`${label} is too large to store safely`);
  }
}
