import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiAuth: vi.fn(),
  requireSystemOwner: vi.fn(),
  runModelHealthProbes: vi.fn(),
}));

vi.mock("../../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../../_lib/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
  requireSystemOwner: mocks.requireSystemOwner,
}));

vi.mock("@/model-health/probe-runner", () => ({
  runModelHealthProbes: mocks.runModelHealthProbes,
}));

import { POST } from "./route";

const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

function request(body: unknown = {}) {
  return new Request("http://localhost/api/model-health/probe", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/model-health/probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENCRYPTION_KEY = "model-health-api-test-key";
    mocks.requireApiAuth.mockResolvedValue(null);
    mocks.requireSystemOwner.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.runModelHealthProbes.mockResolvedValue({
      considered: 2,
      probed: 1,
      healthy: 1,
      unhealthy: 0,
      skippedFresh: 1,
      skippedDisabled: 0,
      skippedCredentialErrors: 0,
      errors: [],
    });
  });

  afterEach(() => {
    if (ORIGINAL_ENCRYPTION_KEY === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
    }
  });

  it("preserves unauthenticated denial before owner gate or runner work", async () => {
    mocks.requireApiAuth.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    );

    const res = await POST(request({ hiveId: "hive-1" }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
    expect(mocks.requireSystemOwner).not.toHaveBeenCalled();
    expect(mocks.runModelHealthProbes).not.toHaveBeenCalled();
  });

  it("rejects authenticated non-owner callers before probing", async () => {
    mocks.requireSystemOwner.mockResolvedValueOnce({
      response: new Response(
        JSON.stringify({ error: "Forbidden: system owner role required" }),
        { status: 403 },
      ),
    });

    const res = await POST(request({ hiveId: "hive-1" }));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: system owner role required");
    expect(mocks.runModelHealthProbes).not.toHaveBeenCalled();
  });

  it("fails closed when ENCRYPTION_KEY is not configured", async () => {
    delete process.env.ENCRYPTION_KEY;

    const res = await POST(request({ hiveId: "hive-1" }));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.error).toBe("ENCRYPTION_KEY is not configured for model health probes");
    expect(mocks.runModelHealthProbes).not.toHaveBeenCalled();
  });

  it("runs probes with sanitized manual options and returns the runner summary", async () => {
    const res = await POST(request({
      hiveId: " hive-1 ",
      limit: 500,
      includeFresh: true,
      includeOnDemand: true,
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.runModelHealthProbes).toHaveBeenCalledWith(mocks.sql, {
      hiveId: "hive-1",
      encryptionKey: "model-health-api-test-key",
      limit: 500,
      includeFresh: true,
      includeOnDemand: true,
    });
    expect(body.data).toMatchObject({
      hiveId: "hive-1",
      limit: 500,
      includeFresh: true,
      includeOnDemand: true,
      result: {
        considered: 2,
        probed: 1,
        healthy: 1,
        skippedFresh: 1,
      },
    });
  });

  it("defaults to a high enough probe limit for discovered model catalogs", async () => {
    const res = await POST(request({ hiveId: "hive-1", includeFresh: true }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.runModelHealthProbes).toHaveBeenCalledWith(mocks.sql, {
      hiveId: "hive-1",
      encryptionKey: "model-health-api-test-key",
      limit: 250,
      includeFresh: true,
      includeOnDemand: false,
    });
    expect(body.data.limit).toBe(250);
  });

  it("rejects invalid JSON before probing", async () => {
    const res = await POST(new Request("http://localhost/api/model-health/probe", {
      method: "POST",
      body: "{",
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid JSON");
    expect(mocks.runModelHealthProbes).not.toHaveBeenCalled();
  });
});
