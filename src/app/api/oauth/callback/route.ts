import { NextResponse } from "next/server";
import { sql } from "../../_lib/db";
import { storeCredential } from "@/credentials/manager";
import { getConnectorDefinition } from "@/connectors/registry";
import { consumeState, exchangeCodeForTokens } from "@/connectors/oauth";

/**
 * GET /api/oauth/callback?code=…&state=…
 *
 * The single redirect URI every OAuth provider points at. We recover the
 * hive + connector_slug from our state table, exchange the code for tokens,
 * encrypt + persist, and create the connector_install row. Then bounce the
 * browser back to wherever the /start call asked us to (default:
 * /setup/connectors).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return redirectBack(url, null, `oauth provider returned error: ${error}`);
  }
  if (!code || !state) {
    return redirectBack(url, null, "missing code or state");
  }

  const encryptionKey = process.env.ENCRYPTION_KEY || "";
  if (!encryptionKey) {
    return NextResponse.json(
      { error: "ENCRYPTION_KEY not configured — cannot store secrets" },
      { status: 500 },
    );
  }

  const stateRow = await consumeState(sql, state);
  if (!stateRow) return redirectBack(url, null, "state expired or unknown");

  const def = getConnectorDefinition(stateRow.connectorSlug);
  if (!def || !def.oauth)
    return redirectBack(url, stateRow.redirectTo, `connector ${stateRow.connectorSlug} unknown`);

  try {
    const tokens = await exchangeCodeForTokens(def, code);

    const cred = await storeCredential(sql, {
      hiveId: stateRow.hiveId,
      name: `${def.name}: ${stateRow.displayName}`,
      key: `connector:${def.slug}:${Date.now()}`,
      value: JSON.stringify(tokens),
      rolesAllowed: [],
      encryptionKey,
    });

    await sql`
      INSERT INTO connector_installs (hive_id, connector_slug, display_name, config, credential_id, status)
      VALUES (
        ${stateRow.hiveId}::uuid,
        ${def.slug},
        ${stateRow.displayName},
        '{}'::jsonb,
        ${cred.id},
        'active'
      )
    `;

    return redirectBack(url, stateRow.redirectTo, null);
  } catch (e) {
    return redirectBack(url, stateRow.redirectTo, (e as Error).message);
  }
}

function redirectBack(
  url: URL,
  target: string | null,
  errorMessage: string | null,
): Response {
  const base = target && target.startsWith("/") ? target : "/setup/connectors";
  const dest = new URL(base, url.origin);
  if (errorMessage) dest.searchParams.set("oauth_error", errorMessage);
  else dest.searchParams.set("oauth_installed", "1");
  return NextResponse.redirect(dest, 302);
}
