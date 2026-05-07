import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), { json: vi.fn() });
  return {
    sql,
    requireApiUser: vi.fn(),
    canAccessHive: vi.fn(),
    insert: vi.fn(),
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

vi.mock("@/db", () => ({
  db: { insert: mocks.insert },
}));

vi.mock("@/db/schema/voice-sessions", () => ({
  ownerVoiceprints: {
    id: "id",
    enrolledAt: "enrolledAt",
  },
}));

import { POST } from "@/app/api/voice/voiceprint/enroll/route";

function enrollRequest(hiveId = "hive-other"): Request {
  const form = new FormData();
  form.append("hiveId", hiveId);
  form.append("sample", new Blob([new Uint8Array(16)], { type: "audio/wav" }));
  return new Request("http://localhost/api/voice/voiceprint/enroll", {
    method: "POST",
    body: form,
  });
}

describe("POST /api/voice/voiceprint/enroll authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValue(false);
    mocks.sql.mockResolvedValue([{ config: { voiceServicesUrl: "http://gpu.local:8790" } }]);
    mocks.insert.mockReturnValue({
      values: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: "vp-1", enrolledAt: new Date(0) }]),
      })),
    });
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ embedding: new Array(192).fill(0.1) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("refuses non-members before reading voice config, calling the service, or storing a voiceprint", async () => {
    const res = await POST(enrollRequest());
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot access this hive");
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mocks.sql, "user-1", "hive-other");
    expect(mocks.sql).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
