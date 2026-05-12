import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canMutateHive: vi.fn(),
  getConnectorDefinition: vi.fn(),
  invokeConnectorReadOnlyOrSystem: vi.fn(),
}));

vi.mock("../../../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../../../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canMutateHive: mocks.canMutateHive,
}));

vi.mock("@/connectors/registry", () => ({
  getConnectorDefinition: mocks.getConnectorDefinition,
}));

vi.mock("@/connectors/runtime", () => ({
  invokeConnectorReadOnlyOrSystem: mocks.invokeConnectorReadOnlyOrSystem,
}));

import { POST } from "./route";

const params = { params: Promise.resolve({ id: "install-1" }) };

function testRequest(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/connector-installs/install-1/test", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/connector-installs/[id]/test access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.canMutateHive.mockResolvedValue(true);
    mocks.sql.mockResolvedValue([{ connector_slug: "discord-webhook", hiveId: "hive-a" }]);
    mocks.getConnectorDefinition.mockReturnValue({
      slug: "discord-webhook",
      operations: [
        {
          slug: "test_connection",
          governance: { effectType: "system", defaultDecision: "allow", riskTier: "low" },
        },
        {
          slug: "send_message",
          governance: { effectType: "notify", defaultDecision: "require_approval", riskTier: "low" },
        },
      ],
    });
    mocks.invokeConnectorReadOnlyOrSystem.mockResolvedValue({ success: true, durationMs: 1 });
  });

  it("rejects unauthenticated callers before resolving the install", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await POST(testRequest(), params);

    expect(res.status).toBe(401);
    expect(mocks.sql).not.toHaveBeenCalled();
    expect(mocks.invokeConnectorReadOnlyOrSystem).not.toHaveBeenCalled();
  });

  it("rejects authenticated non-members before testing guessed install IDs", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canMutateHive.mockResolvedValueOnce(false);

    const res = await POST(testRequest(), params);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot mutate this hive");
    expect(mocks.canMutateHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-a");
    expect(mocks.invokeConnectorReadOnlyOrSystem).not.toHaveBeenCalled();
  });

  it("allows hive members to run only the safe system test operation", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mocks.canMutateHive.mockResolvedValueOnce(true);

    const res = await POST(testRequest({ operation: "send_message", args: { content: "ping" } }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ success: true, durationMs: 1 });
    expect(mocks.canMutateHive).toHaveBeenCalledWith(mocks.sql, "member-1", "hive-a");
    expect(mocks.invokeConnectorReadOnlyOrSystem).toHaveBeenCalledWith(mocks.sql, {
      installId: "install-1",
      operation: "test_connection",
      args: {},
      actor: "owner-test",
    });
  });

  it("rejects connectors without a safe system test operation", async () => {
    mocks.getConnectorDefinition.mockReturnValueOnce({
      slug: "unsafe",
      operations: [
        {
          slug: "send_message",
          governance: { effectType: "notify", defaultDecision: "require_approval", riskTier: "low" },
        },
      ],
    });

    const res = await POST(testRequest(), params);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/safe test operation/i);
    expect(mocks.invokeConnectorReadOnlyOrSystem).not.toHaveBeenCalled();
  });
});
