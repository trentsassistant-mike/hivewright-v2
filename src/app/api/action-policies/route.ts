import { NextResponse } from "next/server";
import { canAccessHive, canMutateHive } from "@/auth/users";
import { CONNECTOR_REGISTRY, toPublicConnector } from "@/connectors/registry";
import { requireApiUser } from "../_lib/auth";
import { sql } from "../_lib/db";

type Decision = "allow" | "require_approval" | "block";
type EffectType = "read" | "notify" | "write" | "financial" | "destructive" | "system";

interface ActionPolicyRow {
  id: string;
  hiveId: string;
  name: string;
  enabled: boolean;
  connectorSlug: string | null;
  operation: string | null;
  effectType: EffectType | null;
  roleSlug: string | null;
  decision: Decision;
  priority: number;
  reason: string | null;
  conditions: Record<string, unknown>;
  createdAt: string | Date;
  updatedAt: string | Date;
}

interface ValidatedPolicy {
  name: string;
  enabled: boolean;
  connectorSlug: string | null;
  operation: string | null;
  effectType: EffectType | null;
  roleSlug: string | null;
  decision: Decision;
  priority: number;
  reason: string | null;
  conditions: Record<string, unknown>;
}

const DECISIONS = new Set<Decision>(["allow", "require_approval", "block"]);
const EFFECT_TYPES = new Set<EffectType>([
  "read",
  "notify",
  "write",
  "financial",
  "destructive",
  "system",
]);

export async function GET(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const hiveId = new URL(request.url).searchParams.get("hiveId")?.trim();
  if (!hiveId) {
    return NextResponse.json({ error: "hiveId is required" }, { status: 400 });
  }

  const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
  if (!hasAccess) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const policies = await loadPolicies(hiveId);
  return NextResponse.json({
    data: {
      hiveId,
      policies,
      connectors: CONNECTOR_REGISTRY.map(toPublicConnector),
    },
  });
}

export async function PATCH(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validatePatchBody(body);
  if ("error" in validation) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const hasAccess = await canMutateHive(sql, authz.user.id, validation.hiveId);
  if (!hasAccess) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await sql.begin(async (tx) => {
    await tx`DELETE FROM action_policies WHERE hive_id = ${validation.hiveId}::uuid`;
    for (const policy of validation.policies) {
      await tx`
        INSERT INTO action_policies (
          hive_id, name, enabled, connector, operation, effect_type, role_slug,
          effect, priority, reason, conditions, created_by, updated_at
        )
        VALUES (
          ${validation.hiveId}::uuid,
          ${policy.name},
          ${policy.enabled},
          ${policy.connectorSlug},
          ${policy.operation},
          ${policy.effectType},
          ${policy.roleSlug},
          ${policy.decision},
          ${policy.priority},
          ${policy.reason},
          ${tx.json(policy.conditions as never)},
          ${authz.user.id},
          NOW()
        )
      `;
    }
  });

  const policies = await loadPolicies(validation.hiveId);
  return NextResponse.json({ data: { hiveId: validation.hiveId, policies } });
}

async function loadPolicies(hiveId: string): Promise<ActionPolicyRow[]> {
  const rows = await sql<{
    id: string;
    hive_id: string;
    name: string;
    enabled: boolean;
    connector: string | null;
    operation: string | null;
    effect_type: EffectType | null;
    role_slug: string | null;
    effect: Decision;
    priority: number;
    reason: string | null;
    conditions: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
  }[]>`
    SELECT
      id,
      hive_id,
      name,
      enabled,
      connector,
      operation,
      effect_type,
      role_slug,
      effect,
      priority,
      reason,
      conditions,
      created_at,
      updated_at
    FROM action_policies
    WHERE hive_id = ${hiveId}::uuid
    ORDER BY priority DESC, name ASC, created_at ASC
  `;

  return rows.map((row) => ({
    id: row.id,
    hiveId: row.hive_id,
    name: row.name,
    enabled: row.enabled,
    connectorSlug: row.connector,
    operation: row.operation,
    effectType: row.effect_type,
    roleSlug: row.role_slug,
    decision: row.effect,
    priority: row.priority,
    reason: row.reason,
    conditions: row.conditions ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function validatePatchBody(body: unknown):
  | { ok: true; hiveId: string; policies: ValidatedPolicy[] }
  | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "Body must be an object" };
  const hiveId = typeof body.hiveId === "string" ? body.hiveId.trim() : "";
  if (!hiveId) return { ok: false, error: "hiveId is required" };
  if (!Array.isArray(body.policies)) return { ok: false, error: "policies must be an array" };

  const policies: ValidatedPolicy[] = [];
  for (let i = 0; i < body.policies.length; i += 1) {
    const result = validatePolicy(body.policies[i], i);
    if ("error" in result) return result;
    policies.push(result.policy);
  }

  return { ok: true, hiveId, policies };
}

function validatePolicy(input: unknown, index: number):
  | { ok: true; policy: ValidatedPolicy }
  | { ok: false; error: string } {
  if (!isRecord(input)) return { ok: false, error: `policies[${index}] must be an object` };

  const name = requiredString(input.name, `policies[${index}].name`);
  if ("error" in name) return name;
  const enabled = typeof input.enabled === "boolean" ? input.enabled : true;
  const connectorSlug = nullableString(input.connectorSlug, `policies[${index}].connectorSlug`);
  if ("error" in connectorSlug) return connectorSlug;
  const operation = nullableString(input.operation, `policies[${index}].operation`);
  if ("error" in operation) return operation;
  const roleSlug = nullableString(input.roleSlug, `policies[${index}].roleSlug`);
  if ("error" in roleSlug) return roleSlug;
  const reason = nullableString(input.reason, `policies[${index}].reason`);
  if ("error" in reason) return reason;

  const effectType = nullableString(input.effectType, `policies[${index}].effectType`);
  if ("error" in effectType) return effectType;
  if (effectType.value !== null && !EFFECT_TYPES.has(effectType.value as EffectType)) {
    return { ok: false, error: `policies[${index}].effectType is invalid` };
  }

  if (typeof input.decision !== "string" || !DECISIONS.has(input.decision as Decision)) {
    return { ok: false, error: `policies[${index}].decision is invalid` };
  }

  const priority = typeof input.priority === "number" && Number.isFinite(input.priority)
    ? Math.trunc(input.priority)
    : 0;

  const conditions = input.conditions ?? {};
  if (!isPlainObject(conditions)) {
    return { ok: false, error: `policies[${index}].conditions must be an object` };
  }
  if (Object.keys(conditions).length > 0) {
    return { ok: false, error: `policies[${index}].conditions are not supported yet` };
  }

  return {
    ok: true,
    policy: {
      name: name.value,
      enabled,
      connectorSlug: connectorSlug.value,
      operation: operation.value,
      effectType: effectType.value as EffectType | null,
      roleSlug: roleSlug.value,
      decision: input.decision as Decision,
      priority,
      reason: reason.value,
      conditions,
    },
  };
}

function requiredString(value: unknown, path: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: `${path} is required` };
  }
  return { ok: true, value: value.trim() };
}

function nullableString(value: unknown, path: string): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === null || value === undefined || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, error: `${path} must be a string or null` };
  return { ok: true, value: value.trim() || null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
