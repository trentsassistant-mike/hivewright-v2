import type { Sql } from "postgres";
import { randomBytes } from "crypto";
import { encrypt, decrypt } from "../credentials/encryption";
import type { ConnectorDefinition, OAuth2Config, OAuth2TokenBundle } from "./registry";

/**
 * OAuth 2.0 authorization-code helper for connectors. Responsibilities:
 *
 *   - Build the authorize URL (with state, scopes, client_id).
 *   - Persist state so the /callback can correlate back to the hive + slug.
 *   - Exchange authorization code for access + refresh tokens at the
 *     provider's tokenUrl.
 *   - Refresh an access token when it's close to expiry.
 *
 * Tokens are stored encrypted (AES-256 via the existing encrypt helper)
 * inside the `credentials` table. The connector_install row references the
 * credential by id, same as api_key connectors.
 */

export interface OAuthClientInfo {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function resolveOAuthClient(
  oauth: OAuth2Config,
): OAuthClientInfo | null {
  const clientId = process.env[oauth.clientIdEnv];
  const clientSecret = process.env[oauth.clientSecretEnv];
  const baseUrl =
    process.env.PUBLIC_BASE_URL ??
    `http://localhost:${process.env.PORT ?? 3002}`;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    // Uniform redirect shape so Google Console / etc. only needs one entry.
    redirectUri: `${baseUrl}/api/oauth/callback`,
  };
}

export function buildAuthorizeUrl(
  def: ConnectorDefinition,
  state: string,
): string {
  if (!def.oauth) throw new Error(`Connector ${def.slug} has no oauth config`);
  const client = resolveOAuthClient(def.oauth);
  if (!client)
    throw new Error(
      `OAuth client env missing for ${def.slug}: ${def.oauth.clientIdEnv} / ${def.oauth.clientSecretEnv}`,
    );
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: def.oauth.scopes.join(" "),
    state,
    ...(def.oauth.extraAuthorizeParams ?? {}),
  });
  return `${def.oauth.authorizeUrl}?${params.toString()}`;
}

export async function storeState(
  sql: Sql,
  input: {
    hiveId: string;
    connectorSlug: string;
    displayName: string;
    redirectTo?: string;
  },
): Promise<string> {
  const state = `${input.connectorSlug}.${randomBytes(24).toString("hex")}`;
  await sql`
    INSERT INTO oauth_states (state, hive_id, connector_slug, display_name, redirect_to, expires_at)
    VALUES (
      ${state},
      ${input.hiveId}::uuid,
      ${input.connectorSlug},
      ${input.displayName},
      ${input.redirectTo ?? null},
      NOW() + INTERVAL '10 minutes'
    )
  `;
  return state;
}

export interface LookedUpState {
  hiveId: string;
  connectorSlug: string;
  displayName: string;
  redirectTo: string | null;
}

export async function consumeState(
  sql: Sql,
  state: string,
): Promise<LookedUpState | null> {
  const [row] = await sql`
    DELETE FROM oauth_states
    WHERE state = ${state}
      AND expires_at > NOW()
    RETURNING hive_id AS "hiveId",
              connector_slug AS "connectorSlug",
              display_name AS "displayName",
              redirect_to AS "redirectTo"
  `;
  return (row as unknown as LookedUpState) ?? null;
}

/**
 * Exchange an authorization code for a token bundle. Called from
 * /api/oauth/callback once we've validated the state parameter.
 */
export async function exchangeCodeForTokens(
  def: ConnectorDefinition,
  code: string,
): Promise<OAuth2TokenBundle> {
  if (!def.oauth) throw new Error(`Connector ${def.slug} has no oauth config`);
  const client = resolveOAuthClient(def.oauth);
  if (!client) throw new Error("OAuth client env missing");
  const body = new URLSearchParams({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: client.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(def.oauth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return parseTokenResponse(await res.json());
}

export async function refreshAccessToken(
  def: ConnectorDefinition,
  refreshToken: string,
): Promise<OAuth2TokenBundle> {
  if (!def.oauth) throw new Error(`Connector ${def.slug} has no oauth config`);
  const client = resolveOAuthClient(def.oauth);
  if (!client) throw new Error("OAuth client env missing");
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: "refresh_token",
  });
  const res = await fetch(def.oauth.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`refresh failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const parsed = parseTokenResponse(await res.json());
  // Most providers don't return the refresh token on refresh — preserve the
  // one we already have so storage stays valid.
  if (!parsed.refreshToken) parsed.refreshToken = refreshToken;
  return parsed;
}

function parseTokenResponse(body: unknown): OAuth2TokenBundle {
  const b = body as Record<string, unknown>;
  const bundle: OAuth2TokenBundle = {
    accessToken: String(b.access_token ?? ""),
  };
  if (!bundle.accessToken) throw new Error("token response missing access_token");
  if (typeof b.refresh_token === "string") bundle.refreshToken = b.refresh_token;
  if (typeof b.token_type === "string") bundle.tokenType = b.token_type;
  if (typeof b.scope === "string") bundle.scope = b.scope;
  if (typeof b.expires_in === "number") {
    bundle.expiresAt = new Date(Date.now() + b.expires_in * 1000).toISOString();
  }
  return bundle;
}

/**
 * Loads the connector install's token bundle, refreshing it first if it's
 * within 60 seconds of expiry. Returns a fresh access_token string ready
 * to use as a bearer credential.
 */
export async function freshAccessTokenFor(
  sql: Sql,
  installId: string,
  def: ConnectorDefinition,
): Promise<string> {
  const [install] = await sql`
    SELECT credential_id FROM connector_installs WHERE id = ${installId}
  `;
  if (!install?.credential_id)
    throw new Error("install has no credential attached");
  const [cred] = await sql`
    SELECT value FROM credentials WHERE id = ${install.credential_id}
  `;
  if (!cred) throw new Error("credential not found");
  const key = process.env.ENCRYPTION_KEY || "";
  const bundle = JSON.parse(decrypt(cred.value as string, key)) as OAuth2TokenBundle;

  const expiresInMs = bundle.expiresAt
    ? new Date(bundle.expiresAt).getTime() - Date.now()
    : Number.POSITIVE_INFINITY;

  if (expiresInMs > 60_000) return bundle.accessToken;
  if (!bundle.refreshToken)
    throw new Error("token expired and no refresh_token available — reconnect the connector");

  const refreshed = await refreshAccessToken(def, bundle.refreshToken);
  await sql`
    UPDATE credentials
    SET value = ${encrypt(JSON.stringify(refreshed), key)}, updated_at = NOW()
    WHERE id = ${install.credential_id}
  `;
  return refreshed.accessToken;
}
