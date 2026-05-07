import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), { json: vi.fn() });
  return {
    sql,
    requireApiUser: vi.fn(),
    canAccessHive: vi.fn(),
    getConnectorDefinition: vi.fn(),
    resolveOAuthClient: vi.fn(),
    storeState: vi.fn(),
    buildAuthorizeUrl: vi.fn(),
  };
});

vi.mock("@/app/api/_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/app/api/_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

vi.mock("@/connectors/registry", () => ({
  getConnectorDefinition: mocks.getConnectorDefinition,
}));

vi.mock("@/connectors/oauth", () => ({
  buildAuthorizeUrl: mocks.buildAuthorizeUrl,
  resolveOAuthClient: mocks.resolveOAuthClient,
  storeState: mocks.storeState,
}));

import { GET } from "@/app/api/oauth/[slug]/start/route";

const ctx = { params: Promise.resolve({ slug: "google-calendar" }) };

function startRequest(hiveId = "hive-a"): Request {
  return new Request(
    `http://localhost/api/oauth/google-calendar/start?hiveId=${hiveId}&displayName=Calendar&redirectTo=/setup/connectors`,
  );
}

describe("GET /api/oauth/:slug/start authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.getConnectorDefinition.mockReturnValue({
      slug: "google-calendar",
      name: "Google Calendar",
      oauth: {
        clientIdEnv: "GOOGLE_CLIENT_ID",
        clientSecretEnv: "GOOGLE_CLIENT_SECRET",
        authorizeUrl: "https://provider.local/auth",
        tokenUrl: "https://provider.local/token",
        scopes: ["calendar.readonly"],
      },
    });
    mocks.resolveOAuthClient.mockReturnValue({
      clientId: "client-id",
      clientSecret: "client-secret",
    });
    mocks.storeState.mockResolvedValue("state-1");
    mocks.buildAuthorizeUrl.mockReturnValue("https://provider.local/auth?state=state-1");
  });

  it("refuses unauthorized hive state creation", async () => {
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(startRequest("hive-other"), ctx);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot access this hive");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-other");
    expect(mocks.storeState).not.toHaveBeenCalled();
    expect(mocks.buildAuthorizeUrl).not.toHaveBeenCalled();
  });

  it("creates OAuth state for authorized hive callers", async () => {
    const res = await GET(startRequest("hive-a"), ctx);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://provider.local/auth?state=state-1");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-a");
    expect(mocks.storeState).toHaveBeenCalledWith(mocks.sql, {
      hiveId: "hive-a",
      connectorSlug: "google-calendar",
      displayName: "Calendar",
      redirectTo: "/setup/connectors",
    });
  });
});
