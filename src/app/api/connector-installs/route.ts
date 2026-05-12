import { sql } from "../_lib/db";
import { jsonError, jsonOk } from "../_lib/responses";
import { requireApiUser } from "../_lib/auth";
import { storeCredential } from "@/credentials/manager";
import { getConnectorDefinition, type ConnectorScopeDeclaration } from "@/connectors/registry";
import { canAccessHive, canMutateHive } from "@/auth/users";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const hiveId = url.searchParams.get("hiveId");
    if (!hiveId) return jsonError("hiveId is required", 400);

    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;
    if (!authz.user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
      if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
    }

    const rows = await sql`
      SELECT
        ci.id,
        ci.hive_id        AS "hiveId",
        ci.connector_slug AS "connectorSlug",
        ci.display_name   AS "displayName",
        ci.config,
        ci.granted_scopes AS "grantedScopes",
        ci.credential_id  AS "credentialId",
        ci.status,
        ci.last_tested_at AS "lastTestedAt",
        ci.last_error     AS "lastError",
        ci.created_at     AS "createdAt",
        (SELECT COUNT(*) FROM connector_events ce
           WHERE ce.install_id = ci.id AND ce.status = 'success'
             AND ce.created_at > NOW() - INTERVAL '7 days') AS "successes7d",
        (SELECT COUNT(*) FROM connector_events ce
           WHERE ce.install_id = ci.id AND ce.status = 'error'
             AND ce.created_at > NOW() - INTERVAL '7 days') AS "errors7d"
      FROM connector_installs ci
      WHERE ci.hive_id = ${hiveId}::uuid
      ORDER BY ci.created_at DESC
    `;
    return jsonOk(rows);
  } catch (err) {
    console.error("[api/connector-installs GET]", err);
    return jsonError("Failed to fetch installs", 500);
  }
}

export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  try {
    const body = await request.json();
    const { hiveId, connectorSlug, displayName, fields } = body as {
      hiveId?: string;
      connectorSlug?: string;
      displayName?: string;
      fields?: Record<string, string>;
      grantedScopes?: string[];
    };

    if (!hiveId || !connectorSlug || !displayName || !fields) {
      return jsonError("hiveId, connectorSlug, displayName and fields are all required", 400);
    }

    if (!authz.user.isSystemOwner) {
      const canMutate = await canMutateHive(sql, authz.user.id, hiveId);
      if (!canMutate) return jsonError("Forbidden: caller cannot mutate this hive", 403);
    }

    const def = getConnectorDefinition(connectorSlug);
    if (!def) return jsonError(`unknown connector: ${connectorSlug}`, 400);

    const requestedScopes: unknown[] = Array.isArray(body.grantedScopes) ? body.grantedScopes : [];
    if (!requestedScopes.every((scope) => typeof scope === "string")) {
      return jsonError("grantedScopes must be an array of strings", 400);
    }
    const declaredScopes = new Set(def.scopes.map((scope: ConnectorScopeDeclaration) => scope.key));
    const unknownScope = requestedScopes.find((scope): scope is string => typeof scope === "string" && !declaredScopes.has(scope));
    if (unknownScope) {
      return jsonError(`unknown scope for ${def.slug}: ${unknownScope}`, 400);
    }
    const grantedScopes = Array.from(new Set([
      ...def.scopes.filter((scope: ConnectorScopeDeclaration) => scope.required).map((scope: ConnectorScopeDeclaration) => scope.key),
      ...(requestedScopes as string[]),
    ]));

    // Validate required non-secret fields.
    for (const f of def.setupFields) {
      if (f.required && !fields[f.key]) {
        return jsonError(`Missing required field: ${f.label}`, 400);
      }
    }

    // Split secrets from non-secret config.
    const secretValues: Record<string, string> = {};
    const publicConfig: Record<string, string> = {};
    for (const f of def.setupFields) {
      const v = fields[f.key];
      if (v === undefined || v === null || v === "") continue;
      if (def.secretFields.includes(f.key)) {
        secretValues[f.key] = v;
      } else {
        publicConfig[f.key] = v;
      }
    }

    const encryptionKey = process.env.ENCRYPTION_KEY || "";
    let credentialId: string | null = null;

    if (Object.keys(secretValues).length > 0) {
      if (!encryptionKey) {
        return jsonError("ENCRYPTION_KEY not configured — cannot store secrets", 500);
      }
      const cred = await storeCredential(sql, {
        hiveId,
        name: `${def.name}: ${displayName}`,
        key: `connector:${def.slug}:${Date.now()}`,
        value: JSON.stringify(secretValues),
        rolesAllowed: [],
        encryptionKey,
      });
      credentialId = cred.id;
    }

    const [row] = await sql`
      INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, granted_scopes, credential_id)
      VALUES (
        ${hiveId}::uuid,
        ${def.slug},
        ${displayName},
        ${sql.json(publicConfig)},
        ${sql.json(grantedScopes)},
        ${credentialId}
      )
      RETURNING id
    `;

    return jsonOk({ id: row.id, connectorSlug: def.slug }, 201);
  } catch (err) {
    console.error("[api/connector-installs POST]", err);
    return jsonError("Failed to install connector", 500);
  }
}
