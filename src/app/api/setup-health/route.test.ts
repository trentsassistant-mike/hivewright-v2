import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  requireApiAuth: vi.fn(),
  requireApiUser: vi.fn(),
  requireSystemOwner: vi.fn(),
  canAccessHive: vi.fn(),
  defaultEnvFilePath: vi.fn(() => "/repo/.env"),
  upsertEnvFileValue: vi.fn(() => ({ envFilePath: "/repo/.env", updated: true })),
}));

vi.mock("../_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("../_lib/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
  requireApiUser: mocks.requireApiUser,
  requireSystemOwner: mocks.requireSystemOwner,
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: mocks.canAccessHive,
}));

vi.mock("@/lib/env-file", () => ({
  defaultEnvFilePath: mocks.defaultEnvFilePath,
  upsertEnvFileValue: mocks.upsertEnvFileValue,
}));

import { GET, PATCH } from "./route";

describe("/api/setup-health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HIVES_WORKSPACE_ROOT;
    mocks.requireApiAuth.mockResolvedValue(null);
    mocks.requireApiUser.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
    mocks.requireSystemOwner.mockResolvedValue({
      user: { id: "owner-1", email: "owner@example.com", isSystemOwner: true },
    });
  });

  it("reports the resolved hive workspace root", async () => {
    process.env.HIVES_WORKSPACE_ROOT = "/tmp/hw-health-hives";

    const res = await GET(new Request("http://localhost/api/setup-health"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      hiveWorkspaceRoot: "/tmp/hw-health-hives",
      envKey: "HIVES_WORKSPACE_ROOT",
      envFilePath: "/repo/.env",
      restartRequired: false,
    });
  });

  it("writes HIVES_WORKSPACE_ROOT and returns the restart prompt", async () => {
    const res = await PATCH(new Request("http://localhost/api/setup-health", {
      method: "PATCH",
      body: JSON.stringify({ hiveWorkspaceRoot: "/tmp/next-hives" }),
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mocks.upsertEnvFileValue).toHaveBeenCalledWith(
      "HIVES_WORKSPACE_ROOT",
      "/tmp/next-hives",
    );
    expect(body.data).toMatchObject({
      hiveWorkspaceRoot: "/tmp/next-hives",
      restartRequired: true,
      restartMessage: "Restart the dispatcher and app for HIVES_WORKSPACE_ROOT to take effect.",
    });
  });

  it("reports owner-facing setup rows for a hive", async () => {
    mocks.sql
      .mockResolvedValueOnce([{ total: 2, configured: 2 }])
      .mockResolvedValueOnce([{ installed: 0, disabled: 0, tested: 0, errors: 0 }])
      .mockResolvedValueOnce([{ config: { maxConcurrentTasks: 3 } }])
      .mockResolvedValueOnce([{ open: 1 }])
      .mockResolvedValueOnce([{ installed: 1, active: 1, tested: 0, errors: 0 }])
      .mockResolvedValueOnce([{ total: 2, enabled: 0 }])
      .mockResolvedValueOnce([{ config: { enabled: false, prepareOnSetup: false } }])
      .mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/setup-health?hiveId=hive-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "models",
          statusLabel: "Ready",
          href: "/setup/models",
        }),
        expect.objectContaining({
          key: "ea",
          statusLabel: "Not set up yet",
          href: "/setup/connectors",
        }),
        expect.objectContaining({
          key: "connectors",
          statusLabel: "Pending/not checked",
          href: "/setup/connectors",
        }),
        expect.objectContaining({
          key: "schedules",
          statusLabel: "Not set up yet",
          href: "/schedules",
        }),
        expect.objectContaining({
          key: "memory",
          statusLabel: "Not set up yet",
          href: "/setup/embeddings",
        }),
      ]),
    );
    expect(body.data.sources).toMatchObject({
      models: "model_catalog, hive_models, model_health, and role_templates",
      schedules: "schedules",
    });
  });
});
