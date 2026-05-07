import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canMutateHive: vi.fn(),
  recordAgentAuditEventBestEffort: vi.fn(),
}));

vi.mock("../../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canMutateHive: mocks.canMutateHive,
}));

vi.mock("@/audit/agent-events", () => ({
  AGENT_AUDIT_EVENTS: {
    connectorRevokedByOwner: "connector.revoked_by_owner",
  },
  recordAgentAuditEventBestEffort: mocks.recordAgentAuditEventBestEffort,
}));

import { DELETE, PATCH } from "./route";

const params = { params: Promise.resolve({ id: "install-1" }) };

describe("DELETE /api/connector-installs/[id] access control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.canMutateHive.mockResolvedValue(true);
    mocks.sql.mockResolvedValue([]);
    mocks.recordAgentAuditEventBestEffort.mockResolvedValue(undefined);
  });

  it("rejects unauthenticated callers before resolving the install", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await DELETE(new Request("http://localhost/api/connector-installs/install-1"), params);

    expect(res.status).toBe(401);
    expect(mocks.canMutateHive).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects authenticated non-members before deleting guessed install IDs", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.sql.mockResolvedValueOnce([{ hiveId: "hive-a" }]);
    mocks.canMutateHive.mockResolvedValueOnce(false);

    const res = await DELETE(new Request("http://localhost/api/connector-installs/install-1"), params);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot mutate this hive");
    expect(mocks.canMutateHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-a");
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it("allows hive members to delete installs", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mocks.sql
      .mockResolvedValueOnce([{
        hiveId: "hive-a",
        connectorSlug: "discord-webhook",
        displayName: "Discord",
      }])
      .mockResolvedValueOnce([]);
    mocks.canMutateHive.mockResolvedValueOnce(true);

    const res = await DELETE(new Request("http://localhost/api/connector-installs/install-1"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ deleted: true });
    expect(mocks.canMutateHive).toHaveBeenCalledWith(mocks.sql, "member-1", "hive-a");
    expect(mocks.sql).toHaveBeenCalledTimes(2);
    expect(mocks.recordAgentAuditEventBestEffort).toHaveBeenCalledWith(mocks.sql, {
      actor: { type: "owner", id: "member-1", label: "member@example.com" },
      eventType: "connector.revoked_by_owner",
      hiveId: "hive-a",
      targetType: "connector_install",
      targetId: "install-1",
      outcome: "success",
      metadata: {
        connectorSlug: "discord-webhook",
        displayName: "Discord",
        revocationAction: "delete",
      },
    });
  });

  it("allows mutate-authorized callers to disable installs without deleting them", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "member-1", email: "member@example.com", isSystemOwner: false },
    });
    mocks.sql
      .mockResolvedValueOnce([{ hiveId: "hive-a" }])
      .mockResolvedValueOnce([{
        id: "install-1",
        hiveId: "hive-a",
        connectorSlug: "discord-webhook",
        displayName: "Discord",
        status: "disabled",
        updatedAt: new Date("2026-05-01T00:00:00.000Z"),
      }]);
    mocks.canMutateHive.mockResolvedValueOnce(true);

    const res = await PATCH(new Request("http://localhost/api/connector-installs/install-1", {
      method: "PATCH",
      body: JSON.stringify({ status: "disabled" }),
    }), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ id: "install-1", status: "disabled" });
    expect(mocks.canMutateHive).toHaveBeenCalledWith(mocks.sql, "member-1", "hive-a");
    expect(mocks.sql).toHaveBeenCalledTimes(2);
    expect(mocks.recordAgentAuditEventBestEffort).toHaveBeenCalledWith(mocks.sql, {
      actor: { type: "owner", id: "member-1", label: "member@example.com" },
      eventType: "connector.revoked_by_owner",
      hiveId: "hive-a",
      targetType: "connector_install",
      targetId: "install-1",
      outcome: "success",
      metadata: {
        connectorSlug: "discord-webhook",
        displayName: "Discord",
        revocationAction: "disable",
      },
    });
  });

  it("rejects invalid install status updates", async () => {
    const res = await PATCH(new Request("http://localhost/api/connector-installs/install-1", {
      method: "PATCH",
      body: JSON.stringify({ status: "broken" }),
    }), params);

    expect(res.status).toBe(400);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
});
