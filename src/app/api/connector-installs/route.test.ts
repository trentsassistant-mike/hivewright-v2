import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), { json: vi.fn((value: unknown) => value) });
  return {
    sql,
    requireApiUser: vi.fn(),
    canAccessHive: vi.fn(),
    canMutateHive: vi.fn(),
    storeCredential: vi.fn(),
    getConnectorDefinition: vi.fn(),
  };
});

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
  canMutateHive: mocks.canMutateHive,
}));

vi.mock("@/credentials/manager", () => ({
  storeCredential: mocks.storeCredential,
}));

vi.mock("@/connectors/registry", () => ({
  getConnectorDefinition: mocks.getConnectorDefinition,
}));

import { GET, POST } from "./route";

const connectorDefinition = {
  slug: "discord-webhook",
  name: "Discord webhook",
  setupFields: [
    { key: "webhookUrl", label: "Webhook URL", required: true },
    { key: "defaultUsername", label: "Sender name" },
  ],
  secretFields: ["webhookUrl"],
  operations: [{ slug: "send_message" }],
};

function installRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/connector-installs", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("GET /api/connector-installs access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.canMutateHive.mockResolvedValue(true);
    mocks.sql.mockResolvedValue([]);
  });

  it("rejects unauthenticated callers before listing installs", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(new Request("http://localhost/api/connector-installs?hiveId=hive-a"));

    expect(res.status).toBe(401);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects authenticated non-members before listing installs", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/connector-installs?hiveId=hive-a"));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot access this hive");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-a");
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("allows hive members to list installs", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(true);
    mocks.sql.mockResolvedValueOnce([{ id: "install-1", hiveId: "hive-a" }]);

    const res = await GET(new Request("http://localhost/api/connector-installs?hiveId=hive-a"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([{ id: "install-1", hiveId: "hive-a" }]);
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/connector-installs access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENCRYPTION_KEY = "test-encryption-key";
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.canMutateHive.mockResolvedValue(true);
    mocks.getConnectorDefinition.mockReturnValue(connectorDefinition);
    mocks.storeCredential.mockResolvedValue({ id: "cred-1" });
    mocks.sql.mockResolvedValue([{ id: "install-1" }]);
  });

  it("rejects authenticated non-members before storing secrets or creating installs", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canMutateHive.mockResolvedValueOnce(false);

    const res = await POST(installRequest({
      hiveId: "hive-a",
      connectorSlug: "discord-webhook",
      displayName: "Discord",
      fields: { webhookUrl: "https://example.test/webhook" },
    }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot mutate this hive");
    expect(mocks.getConnectorDefinition).not.toHaveBeenCalled();
    expect(mocks.storeCredential).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("allows hive members to create installs and credential material", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mocks.canMutateHive.mockResolvedValueOnce(true);

    const res = await POST(installRequest({
      hiveId: "hive-a",
      connectorSlug: "discord-webhook",
      displayName: "Discord",
      fields: {
        webhookUrl: "https://example.test/webhook",
        defaultUsername: "HiveWright",
      },
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data).toEqual({ id: "install-1", connectorSlug: "discord-webhook" });
    expect(mocks.canMutateHive).toHaveBeenCalledWith(mocks.sql, "member-1", "hive-a");
    expect(mocks.storeCredential).toHaveBeenCalledWith(
      mocks.sql,
      expect.objectContaining({ hiveId: "hive-a", value: JSON.stringify({ webhookUrl: "https://example.test/webhook" }) }),
    );
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });
});
