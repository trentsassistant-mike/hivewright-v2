import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/app/api/_lib/db", () => ({
  sql: vi.fn(),
}));

vi.mock("@/app/api/_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
}));

import { GET as getHive } from "@/app/api/hives/[id]/route";
import { GET as searchMemory } from "@/app/api/memory/search/route";
import { GET as getTimeline } from "@/app/api/memory/timeline/route";
import { GET as listBoardSessions } from "@/app/api/board/sessions/route";
import { GET as getBoardSession } from "@/app/api/board/sessions/[id]/route";
import { sql } from "@/app/api/_lib/db";
import { requireApiUser } from "@/app/api/_lib/auth";
import { canAccessHive } from "@/auth/users";

const mockSql = vi.mocked(sql) as unknown as Mock;
const mockRequireApiUser = vi.mocked(requireApiUser);
const mockCanAccessHive = vi.mocked(canAccessHive);

const memberUser = {
  id: "user-1",
  email: "member@example.com",
  isSystemOwner: false,
};

const hiveRow = {
  id: "hive-a",
  slug: "hive-a",
  name: "Hive A",
  type: "digital",
  description: null,
  mission: null,
  workspace_path: "/tmp/hive-a",
  is_system_fixture: false,
  created_at: "2026-04-27T00:00:00.000Z",
};

const boardSessionRow = {
  id: "session-1",
  hive_id: "hive-a",
  question: "What next?",
  status: "completed",
  recommendation: "Proceed",
  error_text: null,
  created_at: "2026-04-27T00:00:00.000Z",
  completed_at: "2026-04-27T00:01:00.000Z",
};

function authAsMember() {
  mockRequireApiUser.mockResolvedValue({ user: memberUser });
}

async function expectForbidden(response: Response) {
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({
    error: "Forbidden: hive access required",
  });
}

describe("cross-hive read route auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authAsMember();
    mockCanAccessHive.mockResolvedValue(true);
  });

  it("GET /api/hives/[id] denies an authenticated non-member", async () => {
    mockSql.mockResolvedValueOnce([hiveRow]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await getHive(
      new Request("http://localhost/api/hives/hive-a"),
      { params: Promise.resolve({ id: "hive-a" }) },
    );

    await expectForbidden(res as unknown as Response);
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-a");
  });

  it("GET /api/hives/[id] allows an authorized member", async () => {
    mockSql.mockResolvedValueOnce([hiveRow]);

    const res = await getHive(
      new Request("http://localhost/api/hives/hive-a"),
      { params: Promise.resolve({ id: "hive-a" }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: { id: "hive-a", name: "Hive A" },
    });
  });

  it("GET /api/memory/search denies an authenticated non-member before memory queries", async () => {
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await searchMemory(
      new Request("http://localhost/api/memory/search?hiveId=hive-a&q=needle"),
    );

    await expectForbidden(res as unknown as Response);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("GET /api/memory/search allows an authorized member", async () => {
    mockSql.mockResolvedValue([]);

    const res = await searchMemory(
      new Request("http://localhost/api/memory/search?hiveId=hive-a&q=needle"),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ data: [] });
    expect(mockSql).toHaveBeenCalledTimes(3);
  });

  it("GET /api/memory/timeline denies an authenticated non-member before timeline queries", async () => {
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await getTimeline(
      new Request("http://localhost/api/memory/timeline?hiveId=hive-a"),
    );

    await expectForbidden(res as unknown as Response);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("GET /api/memory/timeline allows an authorized member", async () => {
    mockSql.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);

    const res = await getTimeline(
      new Request("http://localhost/api/memory/timeline?hiveId=hive-a&store=role_memory"),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
  });

  it("GET /api/board/sessions denies an authenticated non-member before listing sessions", async () => {
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await listBoardSessions(
      new Request("http://localhost/api/board/sessions?hiveId=hive-a"),
    );

    await expectForbidden(res as unknown as Response);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it("GET /api/board/sessions allows an authorized member", async () => {
    mockSql.mockResolvedValueOnce([boardSessionRow]);

    const res = await listBoardSessions(
      new Request("http://localhost/api/board/sessions?hiveId=hive-a"),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: [{ id: "session-1", question: "What next?" }],
    });
  });

  it("GET /api/board/sessions/[id] denies an authenticated non-member after resolving the session hive", async () => {
    mockSql.mockResolvedValueOnce([boardSessionRow]);
    mockCanAccessHive.mockResolvedValueOnce(false);

    const res = await getBoardSession(
      new Request("http://localhost/api/board/sessions/session-1"),
      { params: Promise.resolve({ id: "session-1" }) },
    );

    await expectForbidden(res as unknown as Response);
    expect(mockCanAccessHive).toHaveBeenCalledWith(mockSql, "user-1", "hive-a");
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it("GET /api/board/sessions/[id] allows an authorized member", async () => {
    mockSql.mockResolvedValueOnce([boardSessionRow]).mockResolvedValueOnce([]);

    const res = await getBoardSession(
      new Request("http://localhost/api/board/sessions/session-1"),
      { params: Promise.resolve({ id: "session-1" }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: { session: { id: "session-1", hive_id: "hive-a" }, turns: [] },
    });
  });

  it("returns 401 before DB access when direct imports are unauthenticated", async () => {
    mockRequireApiUser.mockResolvedValueOnce({
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const res = await getBoardSession(
      new Request("http://localhost/api/board/sessions/session-1"),
      { params: Promise.resolve({ id: "session-1" }) },
    );

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });
});
