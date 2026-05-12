import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import {
  buildAuthorizeUrl,
  consumeState,
  exchangeCodeForTokens,
  refreshAccessToken,
  storeState,
} from "@/connectors/oauth";
import type { ConnectorDefinition } from "@/connectors/registry";

const HIVE = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

const fakeOauthDef: ConnectorDefinition = {
  slug: "fake-oauth",
  name: "Fake OAuth",
  category: "other",
  description: "",
  authType: "oauth2",
  setupFields: [],
  secretFields: [],
  scopes: [],
  operations: [],
  oauth: {
    authorizeUrl: "https://example.test/authorize",
    tokenUrl: "https://example.test/token",
    scopes: ["read", "write"],
    clientIdEnv: "FAKE_OAUTH_CLIENT_ID",
    clientSecretEnv: "FAKE_OAUTH_CLIENT_SECRET",
    extraAuthorizeParams: { access_type: "offline" },
  },
};

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE}, 'oauth-biz', 'OAuth Biz', 'digital')
  `;
  process.env.FAKE_OAUTH_CLIENT_ID = "cid";
  process.env.FAKE_OAUTH_CLIENT_SECRET = "sec";
  process.env.PUBLIC_BASE_URL = "https://app.test";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildAuthorizeUrl", () => {
  it("builds the provider URL with scope, state and extra params", () => {
    const url = new URL(buildAuthorizeUrl(fakeOauthDef, "s-123"));
    expect(url.origin + url.pathname).toBe("https://example.test/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.test/api/oauth/callback",
    );
    expect(url.searchParams.get("scope")).toBe("read write");
    expect(url.searchParams.get("state")).toBe("s-123");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });
});

describe("state round-trip", () => {
  it("stores state and consumes it exactly once", async () => {
    const state = await storeState(sql, {
      hiveId: HIVE,
      connectorSlug: "fake-oauth",
      displayName: "My Fake",
      redirectTo: "/setup/connectors",
    });
    const first = await consumeState(sql, state);
    expect(first?.hiveId).toBe(HIVE);
    expect(first?.connectorSlug).toBe("fake-oauth");

    // second consume must fail
    const second = await consumeState(sql, state);
    expect(second).toBeNull();
  });
});

describe("exchangeCodeForTokens", () => {
  it("parses access_token / refresh_token / expires_in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "at-1",
              refresh_token: "rt-1",
              expires_in: 3600,
              token_type: "Bearer",
              scope: "read write",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const bundle = await exchangeCodeForTokens(fakeOauthDef, "abc123");
    expect(bundle.accessToken).toBe("at-1");
    expect(bundle.refreshToken).toBe("rt-1");
    expect(bundle.expiresAt).toBeTruthy();
  });

  it("throws on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad", { status: 400 })),
    );
    await expect(exchangeCodeForTokens(fakeOauthDef, "abc")).rejects.toThrow(/400/);
  });
});

describe("refreshAccessToken", () => {
  it("preserves the existing refresh token when the provider omits it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ access_token: "at-new", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const bundle = await refreshAccessToken(fakeOauthDef, "rt-old");
    expect(bundle.accessToken).toBe("at-new");
    expect(bundle.refreshToken).toBe("rt-old");
  });
});
