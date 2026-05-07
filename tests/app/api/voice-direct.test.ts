import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: Object.assign(vi.fn(), { json: vi.fn() }),
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
}));

vi.mock("@/app/api/_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("@/app/api/_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

import { POST } from "@/app/api/voice/direct/route";
import { verifyVoiceSessionToken } from "@/lib/voice-session-token";

function directRequest(body: unknown, host = "voice.example.test"): Request {
  return new Request(`https://${host}/api/voice/direct`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/voice/direct", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_SERVICE_TOKEN = "test-secret-do-not-ship";
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(true);
  });

  it("returns wsUrl + sessionToken for an authorized caller", async () => {
    const res = await POST(directRequest({ hiveId: "hive-1" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.expiresIn).toBe(60);
    expect(body.wsUrl).toMatch(/^wss:\/\/voice\.example\.test\/api\/voice\/direct\/ws\?token=/);
    expect(typeof body.sessionToken).toBe("string");
    // Round-trip: the minted token verifies and carries the right claims.
    const payload = verifyVoiceSessionToken(body.sessionToken);
    expect(payload?.hiveId).toBe("hive-1");
    expect(payload?.ownerId).toBe("user-1");
  });

  it("rejects when hiveId is missing", async () => {
    const res = await POST(directRequest({}));
    expect(res.status).toBe(400);
  });

  it("refuses non-members before minting a token", async () => {
    mocks.canAccessHive.mockResolvedValueOnce(false);
    const res = await POST(directRequest({ hiveId: "hive-other" }));
    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-other");
  });

  it("returns the requireApiUser denial response when unauthenticated", async () => {
    const denied = new Response("Unauthorized", { status: 401 });
    mocks.requireApiUser.mockResolvedValueOnce({ response: denied });
    const res = await POST(directRequest({ hiveId: "hive-1" }));
    expect(res.status).toBe(401);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
  });

  it("allows system owners through without per-hive access checks", async () => {
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    const res = await POST(directRequest({ hiveId: "hive-x" }));
    expect(res.status).toBe(200);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
  });
});
