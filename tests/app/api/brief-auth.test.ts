import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";

vi.mock("@/app/api/_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
}));

import { createBriefGetHandler } from "@/app/api/brief/route";
import { requireApiUser } from "@/app/api/_lib/auth";
import { canAccessHive } from "@/auth/users";

const mockRequireApiUser = requireApiUser as unknown as ReturnType<typeof vi.fn>;
const mockCanAccessHive = canAccessHive as unknown as ReturnType<typeof vi.fn>;

const HIVE_ID = "11111111-1111-4111-8111-111111111111";

function asSql(db: ReturnType<typeof vi.fn>): Sql {
  return db as unknown as Sql;
}

describe("GET /api/brief auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it("rejects callers without access to the requested hive before brief queries", async () => {
    const db = vi.fn();
    mockRequireApiUser.mockResolvedValueOnce({
      user: { id: "user-1", email: "user@example.com", isSystemOwner: false },
    });
    mockCanAccessHive.mockResolvedValueOnce(false);

    const GET = createBriefGetHandler(asSql(db));
    const res = await GET(new Request(`http://localhost/api/brief?hiveId=${HIVE_ID}`));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("Forbidden: caller cannot access this hive");
    expect(mockCanAccessHive).toHaveBeenCalledWith(asSql(db), "user-1", HIVE_ID);
    expect(db).not.toHaveBeenCalled();
  });

  it("allows system-owner callers without hive membership lookup", async () => {
    const db = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          tasks_completed_24h: "0",
          tasks_failed_24h: "0",
          goals_completed_7d: "0",
          unresolvable_tasks: "0",
          expiring_creds: "0",
        },
      ]);

    const GET = createBriefGetHandler(asSql(db));
    const res = await GET(new Request(`http://localhost/api/brief?hiveId=${HIVE_ID}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.flags.totalPendingDecisions).toBe(0);
    expect(mockCanAccessHive).not.toHaveBeenCalled();
  });
});
