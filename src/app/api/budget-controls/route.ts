import { sql } from "../_lib/db";
import { jsonOk, jsonError } from "../_lib/responses";
import { requireApiUser } from "../_lib/auth";
import { canAccessHive, canMutateHive } from "@/auth/users";
import { normalizeAiBudgetSettings, type BudgetWindow } from "@/budget/ai-budget";

const ALLOWED_SCOPES = new Set(["hive", "outcome", "goal", "task"]);

type BudgetScope = "hive" | "outcome" | "goal" | "task";

type BudgetControlRow = {
  id: string;
  hive_id: string;
  scope: BudgetScope;
  scope_id: string | null;
  cap_cents: number;
  budget_window: BudgetWindow;
  currency: string;
  created_at: Date;
  updated_at: Date;
};

function serializeBudgetControl(row: BudgetControlRow) {
  return {
    id: row.id,
    hiveId: row.hive_id,
    scope: row.scope,
    scopeId: row.scope_id,
    capCents: row.cap_cents,
    window: row.budget_window,
    currency: row.currency,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseScope(value: unknown): BudgetScope | null {
  if (typeof value !== "string" || !ALLOWED_SCOPES.has(value)) return null;
  return value as BudgetScope;
}

function requireUuidish(value: unknown): string | null {
  return typeof value === "string" && value.length >= 32 ? value : null;
}

async function scopeBelongsToHive(hiveId: string, scope: BudgetScope, scopeId: string | null): Promise<boolean> {
  if (scope === "hive") return scopeId === null;
  if (!scopeId) return false;

  if (scope === "outcome") {
    const [row] = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM hive_targets WHERE id = ${scopeId}::uuid AND hive_id = ${hiveId}::uuid
    `;
    return row.c > 0;
  }

  if (scope === "goal") {
    const [row] = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM goals WHERE id = ${scopeId}::uuid AND hive_id = ${hiveId}::uuid
    `;
    return row.c > 0;
  }

  const [row] = await sql<{ c: number }[]>`
    SELECT COUNT(*)::int AS c FROM tasks WHERE id = ${scopeId}::uuid AND hive_id = ${hiveId}::uuid
  `;
  return row.c > 0;
}

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const url = new URL(request.url);
  const hiveId = requireUuidish(url.searchParams.get("hiveId"));
  if (!hiveId) return jsonError("hiveId is required", 400);

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
    if (!hasAccess) return jsonError("Forbidden: hive access required", 403);
  }

  const rows = await sql<BudgetControlRow[]>`
    SELECT id, hive_id, scope, scope_id, cap_cents, budget_window, currency, created_at, updated_at
    FROM budget_controls
    WHERE hive_id = ${hiveId}::uuid
    ORDER BY scope, created_at DESC
  `;

  return jsonOk(rows.map(serializeBudgetControl));
}

export async function PUT(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }

  const hiveId = requireUuidish(body.hiveId);
  if (!hiveId) return jsonError("hiveId is required", 400);

  const scope = parseScope(body.scope);
  if (!scope) return jsonError("scope must be one of hive, outcome, goal, task", 400);

  const scopeId = scope === "hive" ? null : requireUuidish(body.scopeId);
  if (scope !== "hive" && !scopeId) return jsonError("scopeId is required for outcome, goal, and task budgets", 400);
  if (scope === "hive" && body.scopeId !== undefined && body.scopeId !== null) return jsonError("hive budgets must not include scopeId", 400);

  if (typeof body.capCents !== "number" || !Number.isFinite(body.capCents)) {
    return jsonError("capCents must be a number", 400);
  }
  if (body.capCents < 0) return jsonError("capCents must be non-negative", 400);

  if (!authz.user.isSystemOwner) {
    const canMutate = await canMutateHive(sql, authz.user.id, hiveId);
    if (!canMutate) return jsonError("Forbidden: hive mutation access required", 403);
  }

  const [hive] = await sql<{ id: string }[]>`SELECT id FROM hives WHERE id = ${hiveId}::uuid`;
  if (!hive) return jsonError("hive not found", 404);

  const belongs = await scopeBelongsToHive(hiveId, scope, scopeId);
  if (!belongs) return jsonError("budget scope does not belong to hive", 400);

  const settings = normalizeAiBudgetSettings({
    capCents: body.capCents,
    window: body.window,
  });

  if (scope === "hive") {
    await sql`
      UPDATE hives
      SET ai_budget_cap_cents = ${settings.capCents},
          ai_budget_window = ${settings.window}
      WHERE id = ${hiveId}::uuid
    `;
  }

  await sql`
    DELETE FROM budget_controls
    WHERE hive_id = ${hiveId}::uuid
      AND scope = ${scope}
      AND COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(${scopeId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
  `;

  const [row] = await sql<BudgetControlRow[]>`
    INSERT INTO budget_controls (hive_id, scope, scope_id, cap_cents, budget_window)
    VALUES (${hiveId}::uuid, ${scope}, ${scopeId}::uuid, ${settings.capCents}, ${settings.window})
    RETURNING id, hive_id, scope, scope_id, cap_cents, budget_window, currency, created_at, updated_at
  `;

  return jsonOk(serializeBudgetControl(row));
}
