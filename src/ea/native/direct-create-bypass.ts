import type { Sql, TransactionSql } from "postgres";
import { NextResponse } from "next/server";

const EA_DIRECT_CREATE_BYPASS_EVENT = "ea.direct_create_bypass";
const EA_DIRECT_CREATE_BYPASS_REASON_REQUIRED = "EA_DIRECT_CREATE_BYPASS_REASON_REQUIRED";

type SqlExecutor = Sql | TransactionSql;

type DirectCreateResource = {
  type: "task" | "goal";
  id: string;
};

export type EaDirectCreateBypass = {
  bypassReason: string;
  source: string | null;
  sourceHiveId: string | null;
  eaThreadId: string | null;
  ownerMessageId: string | null;
  route: string;
};

function readHeader(request: Request, name: string): string | null {
  const value = request.headers.get(name);
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function readBypassReason(body: Record<string, unknown>): string | null {
  const value = body.bypassReason;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isEaOriginRequest(request: Request): boolean {
  return (
    readHeader(request, "x-hivewright-ea-source") !== null ||
    readHeader(request, "x-hivewright-ea-source-hive-id") !== null ||
    readHeader(request, "x-hivewright-ea-thread-id") !== null ||
    readHeader(request, "x-hivewright-ea-owner-message-id") !== null
  );
}

export function requireEaDirectCreateBypassReason(
  request: Request,
  body: Record<string, unknown>,
): { ok: true; bypass: EaDirectCreateBypass | null } | { ok: false; response: Response } {
  if (!isEaOriginRequest(request)) return { ok: true, bypass: null };

  const bypassReason = readBypassReason(body);
  if (!bypassReason) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "EA-origin direct task/goal creates must include bypassReason and are break-glass only. Use /api/work for normal owner work.",
          code: EA_DIRECT_CREATE_BYPASS_REASON_REQUIRED,
        },
        { status: 400 },
      ),
    };
  }

  const url = new URL(request.url);
  return {
    ok: true,
    bypass: {
      bypassReason,
      source: readHeader(request, "x-hivewright-ea-source"),
      sourceHiveId: readHeader(request, "x-hivewright-ea-source-hive-id"),
      eaThreadId: readHeader(request, "x-hivewright-ea-thread-id"),
      ownerMessageId: readHeader(request, "x-hivewright-ea-owner-message-id"),
      route: url.pathname,
    },
  };
}

export async function recordEaDirectCreateBypass(
  sql: SqlExecutor,
  input: {
    hiveId: string;
    bypass: EaDirectCreateBypass | null;
    resource: DirectCreateResource;
  },
): Promise<void> {
  if (!input.bypass) return;

  const taskId = input.resource.type === "task" ? input.resource.id : null;
  const goalId = input.resource.type === "goal" ? input.resource.id : null;
  const metadata = {
    bypassReason: input.bypass.bypassReason,
    route: input.bypass.route,
    source: input.bypass.source,
    sourceHiveId: input.bypass.sourceHiveId,
    eaThreadId: input.bypass.eaThreadId,
    ownerMessageId: input.bypass.ownerMessageId,
    createdResourceType: input.resource.type,
    createdResourceId: input.resource.id,
  };

  await sql`
    INSERT INTO agent_audit_events (
      event_type,
      actor_type,
      actor_id,
      actor_label,
      hive_id,
      goal_id,
      task_id,
      target_type,
      target_id,
      outcome,
      metadata
    )
    VALUES (
      ${EA_DIRECT_CREATE_BYPASS_EVENT},
      'agent',
      'ea',
      'Executive Assistant',
      ${input.hiveId},
      ${goalId},
      ${taskId},
      ${input.resource.type},
      ${input.resource.id},
      'success',
      ${sql.json(metadata as Parameters<typeof sql.json>[0])}
    )
  `;
}
