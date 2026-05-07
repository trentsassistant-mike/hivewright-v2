import { sql } from "../_lib/db";
import { jsonOk, jsonError, parseSearchParams } from "../_lib/responses";
import { requireApiAuth, requireSystemOwner } from "../_lib/auth";
import { storeCredential } from "@/credentials/manager";

export async function GET(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;
  try {
    const params = parseSearchParams(request.url);
    const hiveId = params.get("hiveId");
    const rows = hiveId
      ? await sql`SELECT id, hive_id, name, key, roles_allowed, expires_at, created_at FROM credentials WHERE hive_id = ${hiveId} OR hive_id IS NULL ORDER BY created_at DESC`
      : await sql`SELECT id, hive_id, name, key, roles_allowed, expires_at, created_at FROM credentials ORDER BY created_at DESC`;
    const data = rows.map((r) => ({
      id: r.id,
      hiveId: r.hive_id ?? null,
      name: r.name,
      key: r.key,
      rolesAllowed: r.roles_allowed,
      expiresAt: r.expires_at ?? null,
      createdAt: r.created_at,
    }));
    return jsonOk(data);
  } catch {
    return jsonError("Failed to fetch credentials", 500);
  }
}

// Per-handler authorization (audit d20f7b46): creating a credential writes
// encrypted system secrets, so session presence alone is insufficient.
// requireApiAuth() is retained as defense-in-depth on top of src/proxy.ts;
// requireSystemOwner() adds the privileged-role gate that blocks
// authenticated non-owner sessions from provisioning secrets.
export async function POST(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  const authz = await requireSystemOwner();
  if ("response" in authz) return authz.response;
  try {
    const body = await request.json();
    const { hiveId, name, key, value, rolesAllowed } = body;
    const encryptionKey = process.env.ENCRYPTION_KEY;
    if (!name || !key || !value) return jsonError("name, key, and value are required", 400);
    if (!encryptionKey) return jsonError("ENCRYPTION_KEY not configured", 500);
    const { id } = await storeCredential(sql, {
      hiveId: hiveId || null,
      name,
      key,
      value,
      rolesAllowed: rolesAllowed || [],
      encryptionKey,
    });
    return jsonOk({ id, name, key }, 201);
  } catch {
    return jsonError("Failed to store credential", 500);
  }
}
