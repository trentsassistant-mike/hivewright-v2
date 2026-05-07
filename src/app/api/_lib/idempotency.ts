import { createHash } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { NextResponse } from "next/server";

const IDEMPOTENCY_TTL_MINUTES = 10;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

type ResponseBody = Record<string, unknown>;

type StoredIdempotencyRow = {
  request_hash: string;
  response_body: ResponseBody;
  response_status: number;
};

export type IdempotentCreateResult<T extends ResponseBody> = {
  body: T;
  status: number;
};

type SqlExecutor = Sql | TransactionSql;

export function readIdempotencyKey(request: Request): string | null | Response {
  const value = request.headers.get("idempotency-key");
  if (value === null) return null;

  const key = value.trim();
  if (key.length === 0) {
    return NextResponse.json({ error: "Idempotency-Key cannot be empty" }, { status: 400 });
  }
  if (key.length > 255) {
    return NextResponse.json({ error: "Idempotency-Key must be 255 characters or fewer" }, { status: 400 });
  }
  if (!PRINTABLE_ASCII.test(key)) {
    return NextResponse.json({ error: "Idempotency-Key must use printable ASCII characters" }, { status: 400 });
  }
  return key;
}

export async function runIdempotentCreate<T extends ResponseBody>(
  sql: Sql,
  input: {
    hiveId: string;
    route: string;
    key: string | null;
    requestBody: unknown;
    create: (tx: SqlExecutor) => Promise<IdempotentCreateResult<T>>;
  },
): Promise<Response> {
  if (input.key === null) {
    const created = await input.create(sql);
    return NextResponse.json(created.body, { status: created.status });
  }

  const requestHash = hashRequestBody(input.requestBody);

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`${input.hiveId}:${input.route}:${input.key}`}))`;
    await tx`
      DELETE FROM idempotency_keys
      WHERE hive_id = ${input.hiveId}::uuid
        AND route = ${input.route}
        AND key = ${input.key}
        AND created_at < NOW() - (${`${IDEMPOTENCY_TTL_MINUTES} minutes`})::interval
    `;

    const [existing] = await tx<StoredIdempotencyRow[]>`
      SELECT request_hash, response_body, response_status
      FROM idempotency_keys
      WHERE hive_id = ${input.hiveId}::uuid
        AND route = ${input.route}
        AND key = ${input.key}
      LIMIT 1
    `;

    if (existing) {
      if (existing.request_hash !== requestHash) {
        return NextResponse.json(
          { error: "Idempotency-Key was already used with a different request body" },
          { status: 409 },
        );
      }
      return NextResponse.json(existing.response_body, { status: existing.response_status });
    }

    const created = await input.create(tx);
    await tx`
      INSERT INTO idempotency_keys (
        hive_id, route, key, request_hash, response_body, response_status
      ) VALUES (
        ${input.hiveId}::uuid,
        ${input.route},
        ${input.key},
        ${requestHash},
        ${tx.json(created.body as never)},
        ${created.status}
      )
    `;
    return NextResponse.json(created.body, { status: created.status });
  });
}

function hashRequestBody(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value))
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => {
      return `${JSON.stringify(key)}:${stableStringify(record[key])}`;
    }).join(",")}}`;
  }
  return JSON.stringify(value);
}
