import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("../../_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
  canMutateHive: vi.fn(),
}));

import { GET, PATCH } from "./route";
import { sql } from "../../_lib/db";
import { requireApiUser } from "../../_lib/auth";
import { canAccessHive, canMutateHive } from "@/auth/users";

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockCanAccessHive = canAccessHive as unknown as ReturnType<typeof vi.fn>;
const mockCanMutateHive = canMutateHive as unknown as ReturnType<typeof vi.fn>;

const params = { params: Promise.resolve({ id: "goal-1" }) };

const goalRow = {
  id: "goal-1",
  hive_id: "hive-1",
  parent_id: null,
  title: "Goal",
  description: null,
  priority: 5,
  status: "active",
  budget_cents: null,
  spent_cents: 0,
  session_id: null,
  created_at: new Date("2026-04-27T00:00:00Z"),
  updated_at: new Date("2026-04-27T00:00:00Z"),
};

describe("GET /api/goals/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it("rejects unauthenticated callers before DB use", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await GET(new Request("http://localhost/api/goals/goal-1"), params);

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });

  it("rejects callers without access to the owning hive before related reads", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockSql.mockResolvedValueOnce([goalRow]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await GET(new Request("http://localhost/api/goals/goal-1"), params);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot access this goal");
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("allows system-owner callers without hive membership lookup", async () => {
    mockSql
      .mockResolvedValueOnce([goalRow])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/goals/goal-1"), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ id: "goal-1", hiveId: "hive-1" });
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/goals/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it("updates allowed fields", async () => {
    mockSql
      .mockResolvedValueOnce([{ id: "goal-1", hive_id: "hive-1" }])
      .mockResolvedValueOnce([{ ...goalRow, title: "Updated", description: "New", priority: 3 }]);

    const res = await PATCH(
      new Request("http://localhost/api/goals/goal-1", {
        method: "PATCH",
        body: JSON.stringify({ title: " Updated ", description: " New ", priority: 3 }),
      }),
      params,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      id: "goal-1",
      title: "Updated",
      description: "New",
      priority: 3,
    });
  });

  it("rejects status changes", async () => {
    const res = await PATCH(
      new Request("http://localhost/api/goals/goal-1", {
        method: "PATCH",
        body: JSON.stringify({ status: "cancelled" }),
      }),
      params,
    );

    expect(res.status).toBe(400);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown goals", async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = await PATCH(
      new Request("http://localhost/api/goals/goal-1", {
        method: "PATCH",
        body: JSON.stringify({ title: "Updated" }),
      }),
      params,
    );

    expect(res.status).toBe(404);
  });

  it("rejects unauthenticated callers before DB use", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    });

    const res = await PATCH(
      new Request("http://localhost/api/goals/goal-1", {
        method: "PATCH",
        body: JSON.stringify({ title: "Updated" }),
      }),
      params,
    );

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("rejects callers without mutation access", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockSql.mockResolvedValueOnce([{ id: "goal-1", hive_id: "hive-1" }]);
    mockCanMutateHive.mockResolvedValueOnce(false);

    const res = await PATCH(
      new Request("http://localhost/api/goals/goal-1", {
        method: "PATCH",
        body: JSON.stringify({ title: "Updated" }),
      }),
      params,
    );

    expect(res.status).toBe(403);
    expect(mockCanMutateHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-1");
    expect(mockSql).toHaveBeenCalledTimes(1);
  });
});
