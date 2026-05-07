import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), { json: vi.fn((value: unknown) => value) });
  return {
    sql,
    requireApiAuth: vi.fn(),
    requireSystemOwner: vi.fn(),
  };
});

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
  requireSystemOwner: mocks.requireSystemOwner,
}));

import { POST } from "./route";

function request(body: unknown) {
  return new Request("http://localhost/api/adapter-config", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/adapter-config owner gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiAuth.mockResolvedValue(null);
    mocks.requireSystemOwner.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it("preserves unauthenticated denial before the owner gate", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const res = await POST(request({
      adapterType: "codex",
      config: { model: "gpt-5.4" },
    }));

    expect(res.status).toBe(401);
    expect(mocks.requireSystemOwner).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("rejects authenticated non-owner callers before saving config", async () => {
    mocks.requireSystemOwner.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({ error: "Forbidden: system owner role required" }),
        { status: 403 },
      ),
    });

    const res = await POST(request({
      adapterType: "codex",
      config: { model: "gpt-5.4" },
    }));

    expect(res.status).toBe(403);
    expect(mocks.requireApiAuth).toHaveBeenCalledTimes(1);
    expect(mocks.requireSystemOwner).toHaveBeenCalledTimes(1);
    expect(mocks.sql).not.toHaveBeenCalled();
  });

  it("allows system owners to update existing adapter config", async () => {
    mocks.sql
      .mockResolvedValueOnce([{ id: "adapter-config-1" }])
      .mockResolvedValueOnce([]);

    const res = await POST(request({
      hiveId: "hive-1",
      adapterType: "codex",
      config: { model: "gpt-5.4" },
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ id: "adapter-config-1", updated: true });
    expect(mocks.sql).toHaveBeenCalledTimes(2);
    expect(mocks.sql.json).toHaveBeenCalledWith({ model: "gpt-5.4" });
  });
});
