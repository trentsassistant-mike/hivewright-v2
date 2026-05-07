import type { Sql, TransactionSql } from "postgres";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EaAuditSource = "dashboard" | "discord" | "voice";

export type CreatedEaResource = {
  type: string;
  id: string;
};

function readHeader(request: Request, name: string): string | null {
  const value = request.headers.get(name);
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function isEaAuditSource(value: string): value is EaAuditSource {
  return value === "dashboard" || value === "discord" || value === "voice";
}

export async function maybeRecordEaHiveSwitch(
  sql: Sql | TransactionSql,
  request: Request,
  toHiveId: string,
  createdResource?: CreatedEaResource,
): Promise<void> {
  const fromHiveId = readHeader(request, "x-hivewright-ea-source-hive-id");
  if (!fromHiveId || fromHiveId === toHiveId) return;
  if (!UUID_RE.test(fromHiveId) || !UUID_RE.test(toHiveId)) return;

  const threadId = readHeader(request, "x-hivewright-ea-thread-id");
  const ownerMessageId = readHeader(request, "x-hivewright-ea-owner-message-id");
  const source = readHeader(request, "x-hivewright-ea-source");
  if (!source || !isEaAuditSource(source)) return;
  if (threadId && !UUID_RE.test(threadId)) return;
  if (ownerMessageId && !UUID_RE.test(ownerMessageId)) return;
  if (createdResource?.id && !UUID_RE.test(createdResource.id)) return;

  const url = new URL(request.url);
  await sql`
    INSERT INTO ea_hive_switch_audit (
      from_hive_id,
      to_hive_id,
      ea_thread_id,
      owner_message_id,
      request_path,
      request_method,
      actor,
      source,
      created_resource_type,
      created_resource_id
    ) VALUES (
      ${fromHiveId},
      ${toHiveId},
      ${threadId ?? null},
      ${ownerMessageId ?? null},
      ${url.pathname},
      ${request.method},
      'ea',
      ${source},
      ${createdResource?.type ?? null},
      ${createdResource?.id ?? null}
    )
  `;
}
