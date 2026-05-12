import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
}));

vi.mock("@/app/api/_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("@/app/api/_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

const { GET } = await import("@/app/api/connector-installs/[id]/actions/route");

describe("GET /api/connector-installs/[id]/actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.canAccessHive.mockResolvedValue(true);
    mocks.sql
      .mockResolvedValueOnce([{ id: "install-1", hive_id: "hive-a", connector_slug: "discord-webhook" }])
      .mockResolvedValueOnce([
        {
          id: "action-1",
          connector: "discord-webhook",
          operation: "send_message",
          state: "succeeded",
          role_slug: "ea",
          policy_id: "policy-1",
          policy_snapshot: { reason: "matched action policy policy-1" },
          request_payload: { args: { content: "hello", token: "[REDACTED]" } },
          created_at: new Date("2026-05-12T01:00:00Z"),
          reviewed_at: new Date("2026-05-12T01:01:00Z"),
          executed_at: new Date("2026-05-12T01:02:00Z"),
          completed_at: new Date("2026-05-12T01:03:00Z"),
        },
      ]);
  });

  it("returns redacted recent action history for an install", async () => {
    const response = await GET(
      new Request("http://localhost/api/connector-installs/install-1/actions"),
      { params: Promise.resolve({ id: "install-1" }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([
      expect.objectContaining({
        id: "action-1",
        connector: "discord-webhook",
        operation: "send_message",
        state: "succeeded",
        roleSlug: "ea",
        policyId: "policy-1",
        policyReason: "matched action policy policy-1",
        payloadSummary: { args: { content: "hello", token: "[REDACTED]" } },
      }),
    ]);
  });

  it("rejects non-member callers before returning history", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);
    mocks.sql.mockReset();
    mocks.sql.mockResolvedValueOnce([{ id: "install-1", hive_id: "hive-a", connector_slug: "discord-webhook" }]);

    const response = await GET(
      new Request("http://localhost/api/connector-installs/install-1/actions"),
      { params: Promise.resolve({ id: "install-1" }) },
    );

    expect(response.status).toBe(403);
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });
});
