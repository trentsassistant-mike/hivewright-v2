import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorDefinition } from "@/connectors/registry";

const mocks = vi.hoisted(() => ({
  consumeState: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  getConnectorDefinition: vi.fn(),
  storeCredential: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("@/app/api/_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("@/connectors/oauth", () => ({
  consumeState: mocks.consumeState,
  exchangeCodeForTokens: mocks.exchangeCodeForTokens,
}));

vi.mock("@/connectors/registry", () => ({
  getConnectorDefinition: mocks.getConnectorDefinition,
}));

vi.mock("@/credentials/manager", () => ({
  storeCredential: mocks.storeCredential,
}));

const { GET } = await import("@/app/api/oauth/callback/route");

const oauthDefinition: ConnectorDefinition = {
  slug: "fake-oauth",
  name: "Fake OAuth",
  category: "other",
  description: "Fake OAuth connector",
  authType: "oauth2",
  setupFields: [],
  secretFields: [],
  operations: [],
  oauth: {
    authorizeUrl: "https://provider.test/authorize",
    tokenUrl: "https://provider.test/token",
    scopes: ["read"],
    clientIdEnv: "FAKE_CLIENT_ID",
    clientSecretEnv: "FAKE_CLIENT_SECRET",
  },
};

describe("GET /api/oauth/callback", () => {
  const originalEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consumeState.mockResolvedValue({
      hiveId: "11111111-1111-4111-8111-111111111111",
      connectorSlug: "fake-oauth",
      displayName: "Fake install",
      redirectTo: "/setup/connectors",
    });
    mocks.getConnectorDefinition.mockReturnValue(oauthDefinition);
    mocks.exchangeCodeForTokens.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: "2026-04-27T00:00:00.000Z",
    });
    mocks.storeCredential.mockResolvedValue({ id: "credential-id" });
    mocks.sql.mockResolvedValue([]);
  });

  afterEach(() => {
    if (originalEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalEncryptionKey;
    }
  });

  it("fails closed before token exchange or persistence when ENCRYPTION_KEY is missing", async () => {
    delete process.env.ENCRYPTION_KEY;

    const response = await GET(
      new Request("https://app.test/api/oauth/callback?code=abc&state=state-1"),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "ENCRYPTION_KEY not configured — cannot store secrets",
    });
    expect(mocks.consumeState).not.toHaveBeenCalled();
    expect(mocks.exchangeCodeForTokens).not.toHaveBeenCalled();
    expect(mocks.storeCredential).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("uses the configured ENCRYPTION_KEY for the existing successful callback flow", async () => {
    process.env.ENCRYPTION_KEY = "oauth-callback-test-key";

    const response = await GET(
      new Request("https://app.test/api/oauth/callback?code=abc&state=state-1"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://app.test/setup/connectors?oauth_installed=1",
    );
    expect(mocks.exchangeCodeForTokens).toHaveBeenCalledWith(oauthDefinition, "abc");
    expect(mocks.storeCredential).toHaveBeenCalledWith(
      mocks.sql,
      expect.objectContaining({
        value: JSON.stringify({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAt: "2026-04-27T00:00:00.000Z",
        }),
        encryptionKey: "oauth-callback-test-key",
      }),
    );
    expect(mocks.sql).toHaveBeenCalledOnce();
  });
});
