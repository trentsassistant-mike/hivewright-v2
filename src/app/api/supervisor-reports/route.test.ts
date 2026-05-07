/**
 * Tests for GET /api/supervisor-reports.
 *
 * Covers input validation and the filter/limit contract:
 *   1. missing hiveId -> 400
 *   2. malformed hiveId -> 400
 *   3. default limit = 20 when no ?limit
 *   4. explicit ?limit is respected
 *   5. ?limit is clamped to MAX_LIMIT (100)
 *   6. invalid or non-positive ?limit falls back to DEFAULT_LIMIT
 *   7. response maps DB snake_case columns to camelCase fields
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiUser: vi.fn(),
  canAccessHive: vi.fn(),
  runSupervisorDigest: vi.fn(),
}));

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiUser: mocks.requireApiUser,
}));

vi.mock("../_lib/responses", () => ({
  jsonOk: (data: unknown, status?: number) =>
    new Response(JSON.stringify({ data }), { status: status ?? 200 }),
  jsonError: (message: string, status: number) =>
    new Response(JSON.stringify({ error: message }), { status }),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

vi.mock("@/supervisor", () => ({
  runSupervisorDigest: mocks.runSupervisorDigest,
}));

import { GET, POST } from "./route";
import { sql } from "../_lib/db";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;

const HIVE_ID = "11111111-1111-1111-1111-111111111111";

function makeRequest(query: string): Request {
  return new Request(`http://localhost/api/supervisor-reports${query}`);
}

/**
 * Extract the literal LIMIT value from the postgres.js template call. The
 * template tag receives strings + interpolated values; LIMIT is the last
 * interpolation, so we read the final `values` entry.
 */
function lastCallLimit(): unknown {
  const lastCall = mockSql.mock.calls[mockSql.mock.calls.length - 1];
  const values = lastCall.slice(1);
  return values[values.length - 1];
}

function lastCallHiveId(): unknown {
  const lastCall = mockSql.mock.calls[mockSql.mock.calls.length - 1];
  const values = lastCall.slice(1);
  return values[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireApiUser.mockResolvedValue({
    user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
  });
  mocks.canAccessHive.mockResolvedValue(true);
});

describe("GET /api/supervisor-reports — access control", () => {
  it("returns 401 for signed-out callers", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(makeRequest(`?hiveId=${HIVE_ID}`));

    expect(res.status).toBe(401);
    expect(mocks.canAccessHive).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("returns 403 when the signed-in caller cannot access the hive", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await GET(makeRequest(`?hiveId=${HIVE_ID}`));

    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mockSql, "user-1", HIVE_ID);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("returns 200 when the signed-in caller can access the hive", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockSql.mockResolvedValueOnce([]);

    const res = await GET(makeRequest(`?hiveId=${HIVE_ID}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mockSql, "user-1", HIVE_ID);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/supervisor-reports — validation", () => {
  it("returns 400 when hiveId is missing", async () => {
    const res = await GET(makeRequest(""));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("hiveId");
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("returns 400 when hiveId is not a UUID", async () => {
    const res = await GET(makeRequest("?hiveId=not-a-uuid"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("UUID");
    expect(mockSql).not.toHaveBeenCalled();
  });
});

describe("GET /api/supervisor-reports — limit behavior", () => {
  it("uses the default limit (20) when ?limit is absent", async () => {
    mockSql.mockResolvedValueOnce([]);
    const res = await GET(makeRequest(`?hiveId=${HIVE_ID}`));
    expect(res.status).toBe(200);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(lastCallLimit()).toBe(20);
  });

  it("passes an explicit ?limit through to the SQL", async () => {
    mockSql.mockResolvedValueOnce([]);
    await GET(makeRequest(`?hiveId=${HIVE_ID}&limit=5`));
    expect(lastCallLimit()).toBe(5);
  });

  it("clamps ?limit to MAX_LIMIT (100) when over", async () => {
    mockSql.mockResolvedValueOnce([]);
    await GET(makeRequest(`?hiveId=${HIVE_ID}&limit=9999`));
    expect(lastCallLimit()).toBe(100);
  });

  it("falls back to default when ?limit is non-numeric", async () => {
    mockSql.mockResolvedValueOnce([]);
    await GET(makeRequest(`?hiveId=${HIVE_ID}&limit=abc`));
    expect(lastCallLimit()).toBe(20);
  });

  it("falls back to default when ?limit is zero or negative", async () => {
    mockSql.mockResolvedValueOnce([]);
    await GET(makeRequest(`?hiveId=${HIVE_ID}&limit=0`));
    expect(lastCallLimit()).toBe(20);

    mockSql.mockResolvedValueOnce([]);
    await GET(makeRequest(`?hiveId=${HIVE_ID}&limit=-3`));
    expect(lastCallLimit()).toBe(20);
  });

  it("filters by the given hiveId", async () => {
    mockSql.mockResolvedValueOnce([]);
    await GET(makeRequest(`?hiveId=${HIVE_ID}`));
    expect(lastCallHiveId()).toBe(HIVE_ID);
  });
});

describe("GET /api/supervisor-reports — response shape", () => {
  it("maps snake_case DB columns to camelCase response fields", async () => {
    const ranAt = new Date("2026-04-20T10:00:00.000Z");
    const fakeReport = { hiveId: HIVE_ID, findings: [], metrics: {} };
    const fakeActions = { findings_addressed: [], actions: [] };
    const fakeOutcomes = [{ status: "applied" }];

    mockSql.mockResolvedValueOnce([
      {
        id: "report-1",
        hive_id: HIVE_ID,
        ran_at: ranAt,
        report: fakeReport,
        actions: fakeActions,
        action_outcomes: fakeOutcomes,
        agent_task_id: "task-1",
        tokens_input: 1200,
        tokens_output: 340,
        cost_cents: 7,
      },
    ]);

    const res = await GET(makeRequest(`?hiveId=${HIVE_ID}`));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toHaveLength(1);
    const row = body.data[0];
    expect(row.id).toBe("report-1");
    expect(row.hiveId).toBe(HIVE_ID);
    expect(row.ranAt).toBe(ranAt.toISOString());
    expect(row.report).toEqual(fakeReport);
    expect(row.actions).toEqual(fakeActions);
    expect(row.actionOutcomes).toEqual(fakeOutcomes);
    expect(row.agentTaskId).toBe("task-1");
    expect(row.tokensInput).toBe(1200);
    expect(row.tokensOutput).toBe(340);
    expect(row.costCents).toBe(7);
  });

  it("preserves nulls for actions/outcomes when agent has not returned yet", async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: "report-2",
        hive_id: HIVE_ID,
        ran_at: new Date(),
        report: { findings: [] },
        actions: null,
        action_outcomes: null,
        agent_task_id: null,
        tokens_input: null,
        tokens_output: null,
        cost_cents: null,
      },
    ]);

    const res = await GET(makeRequest(`?hiveId=${HIVE_ID}`));
    const body = await res.json();

    expect(body.data[0].actions).toBeNull();
    expect(body.data[0].actionOutcomes).toBeNull();
    expect(body.data[0].agentTaskId).toBeNull();
  });

  it("returns 500 when the DB throws", async () => {
    mockSql.mockRejectedValueOnce(new Error("connection refused"));
    const res = await GET(makeRequest(`?hiveId=${HIVE_ID}`));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});

describe("POST /api/supervisor-reports — on-demand digest", () => {
  it("runs a read-only supervisor digest for the requested hive", async () => {
    mocks.runSupervisorDigest.mockResolvedValueOnce({
      skipped: false,
      reportId: "report-3",
      findings: 2,
      summary: "Hive health digest: 2 findings.",
    });

    const res = await POST(
      new Request(`http://localhost/api/supervisor-reports?hiveId=${HIVE_ID}`, {
        method: "POST",
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.runSupervisorDigest).toHaveBeenCalledWith(mockSql, HIVE_ID);
    expect(body.data).toEqual({
      skipped: false,
      reportId: "report-3",
      findings: 2,
      summary: "Hive health digest: 2 findings.",
    });
  });

  it("uses the same access control as the report feed", async () => {
    mocks.requireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mocks.canAccessHive.mockResolvedValueOnce(false);

    const res = await POST(
      new Request(`http://localhost/api/supervisor-reports?hiveId=${HIVE_ID}`, {
        method: "POST",
      }),
    );

    expect(res.status).toBe(403);
    expect(mocks.canAccessHive).toHaveBeenCalledWith(mockSql, "user-1", HIVE_ID);
    expect(mocks.runSupervisorDigest).not.toHaveBeenCalled();
  });

  it("rejects malformed hive ids before scanning", async () => {
    const res = await POST(
      new Request("http://localhost/api/supervisor-reports?hiveId=bad", {
        method: "POST",
      }),
    );

    expect(res.status).toBe(400);
    expect(mocks.runSupervisorDigest).not.toHaveBeenCalled();
  });
});
