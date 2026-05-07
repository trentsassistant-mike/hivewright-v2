import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const mocks = vi.hoisted(() => {
  const sql = Object.assign(vi.fn(), { json: vi.fn((value: unknown) => value) });
  return {
    sql,
    requireApiAuth: vi.fn(),
    requireApiUser: vi.fn(),
    requireSystemOwner: vi.fn(),
    canAccessHive: vi.fn(),
  };
});

vi.mock("@/app/api/_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("@/app/api/_lib/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
  requireApiUser: mocks.requireApiUser,
  requireSystemOwner: mocks.requireSystemOwner,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

import { GET as getAdapterConfig } from "@/app/api/adapter-config/route";
import { GET as getDashboardSummary } from "@/app/api/dashboard/summary/route";
import { GET as getProjects } from "@/app/api/projects/route";
import { GET as getProject } from "@/app/api/projects/[id]/route";
import { GET as getActiveSupervisors } from "@/app/api/active-supervisors/route";
import { GET as getAnalytics } from "@/app/api/analytics/route";
import { GET as getEntities } from "@/app/api/entities/route";

const HIVE_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

const memberUser = {
  id: "member-1",
  email: "member@example.com",
  isSystemOwner: false,
};

type RouteCase = {
  name: string;
  call: () => Promise<Response>;
  seedSuccess: () => void;
  deniedQueriesBeforeAccess?: number;
};

function unauthorized() {
  return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
}

function signedInMember() {
  mocks.requireApiUser.mockResolvedValue({ user: memberUser });
}

function signedOut() {
  mocks.requireApiUser.mockResolvedValue({ response: unauthorized() });
}

function projectRow() {
  return {
    id: PROJECT_ID,
    hive_id: HIVE_ID,
    slug: "ops",
    name: "Ops",
    workspace_path: "/tmp/ops",
    git_repo: true,
    created_at: new Date("2026-05-01T00:00:00.000Z"),
    updated_at: new Date("2026-05-01T00:00:00.000Z"),
  };
}

function routeCases(): RouteCase[] {
  return [
    {
      name: "GET /api/adapter-config",
      call: () => getAdapterConfig(new Request(`http://localhost/api/adapter-config?hiveId=${HIVE_ID}`)) as Promise<Response>,
      seedSuccess: () => {
        mocks.sql.mockResolvedValueOnce([]);
      },
    },
    {
      name: "GET /api/dashboard/summary",
      call: () => getDashboardSummary(new Request(`http://localhost/api/dashboard/summary?hiveId=${HIVE_ID}`)) as Promise<Response>,
      seedSuccess: () => {
        mocks.sql.mockResolvedValueOnce([
          {
            agents_enabled: "0",
            tasks_in_progress: "0",
            month_spend_cents: "0",
            pending_approvals: "0",
          },
        ]);
      },
    },
    {
      name: "GET /api/projects",
      call: () => getProjects(new Request(`http://localhost/api/projects?hiveId=${HIVE_ID}`)) as Promise<Response>,
      seedSuccess: () => {
        mocks.sql.mockResolvedValueOnce([{ total: "0" }]).mockResolvedValueOnce([]);
      },
    },
    {
      name: "GET /api/projects/[id]",
      call: () => getProject(
        new Request(`http://localhost/api/projects/${PROJECT_ID}`),
        { params: Promise.resolve({ id: PROJECT_ID }) },
      ) as Promise<Response>,
      seedSuccess: () => {
        mocks.sql.mockResolvedValueOnce([projectRow()]);
      },
      deniedQueriesBeforeAccess: 1,
    },
    {
      name: "GET /api/active-supervisors",
      call: () => getActiveSupervisors(new Request(`http://localhost/api/active-supervisors?hiveId=${HIVE_ID}`)) as Promise<Response>,
      seedSuccess: () => {
        mocks.sql.mockResolvedValueOnce([]);
      },
    },
    {
      name: "GET /api/analytics",
      call: () => getAnalytics(new Request(`http://localhost/api/analytics?hiveId=${HIVE_ID}&period=all`)) as Promise<Response>,
      seedSuccess: () => {
        mocks.sql.mockResolvedValueOnce([]);
      },
    },
    {
      name: "GET /api/entities",
      call: () => getEntities(new Request(`http://localhost/api/entities?hiveId=${HIVE_ID}`)) as Promise<Response>,
      seedSuccess: () => {
        mocks.sql.mockResolvedValueOnce([]);
      },
    },
  ];
}

describe("Sprint 4A verified hive read auth gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedInMember();
    mocks.canAccessHive.mockResolvedValue(true);
  });

  for (const route of routeCases()) {
    describe(route.name, () => {
      it("returns 401 when signed out", async () => {
        signedOut();

        const res = await route.call();

        expect(res.status).toBe(401);
        expect(mocks.sql).not.toHaveBeenCalled();
        expect(mocks.canAccessHive).not.toHaveBeenCalled();
      });

      it("returns 403 when signed in without hive access", async () => {
        mocks.canAccessHive.mockResolvedValueOnce(false);
        if (route.deniedQueriesBeforeAccess) {
          mocks.sql.mockResolvedValueOnce([projectRow()]);
        }

        const res = await route.call();

        expect(res.status).toBe(403);
        await expect(res.json()).resolves.toMatchObject({
          error: "Forbidden: caller cannot access this hive",
        });
        expect(mocks.canAccessHive).toHaveBeenCalledWith(
          mocks.sql,
          memberUser.id,
          HIVE_ID,
        );
        expect(mocks.sql).toHaveBeenCalledTimes(route.deniedQueriesBeforeAccess ?? 0);
      });

      it("returns 200 when signed in with hive access", async () => {
        route.seedSuccess();

        const res = await route.call();

        expect(res.status).toBe(200);
        expect(mocks.canAccessHive).toHaveBeenCalledWith(
          mocks.sql,
          memberUser.id,
          HIVE_ID,
        );
        expect((mocks.sql as Mock).mock.calls.length).toBeGreaterThan(0);
      });
    });
  }
});
