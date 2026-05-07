import { describe, expect, it } from "vitest";
import { buildSetupHealthRows, type SetupHealthSnapshot } from "@/setup-health/status";

const baseSnapshot: SetupHealthSnapshot = {
  roles: { total: 3, configured: 3 },
  ea: { installed: true, disabled: false, lastTested: true, hasError: false },
  dispatcher: { configured: true, maxConcurrentAgents: 3, openTasks: 0 },
  connectors: { installed: 1, active: 1, tested: 1, withErrors: 0 },
  schedules: { total: 2, enabled: 2 },
  memory: {
    requested: true,
    disabled: false,
    embeddingConfigured: true,
    embeddingStatus: "ready",
    embeddingError: false,
  },
};

describe("buildSetupHealthRows", () => {
  it("maps a fully prepared hive to ready owner-facing rows", () => {
    const rows = buildSetupHealthRows(baseSnapshot);

    expect(rows.map((row) => [row.key, row.status])).toEqual([
      ["models", "ready"],
      ["ea", "ready"],
      ["dispatcher", "ready"],
      ["connectors", "ready"],
      ["schedules", "ready"],
      ["memory", "ready"],
    ]);
    expect(rows.every((row) => row.statusLabel === "Ready")).toBe(true);
    expect(rows.map((row) => row.href)).toEqual([
      "/setup/models",
      "/setup/connectors",
      "/tasks",
      "/setup/connectors",
      "/schedules",
      "/memory/health",
    ]);
  });

  it("represents deferred EA setup and skipped connectors honestly", () => {
    const rows = buildSetupHealthRows({
      ...baseSnapshot,
      ea: { installed: false, disabled: false, lastTested: false, hasError: false },
      connectors: { installed: 0, active: 0, tested: 0, withErrors: 0 },
    });

    expect(rows.find((row) => row.key === "ea")).toMatchObject({
      status: "not_set_up",
      statusLabel: "Not set up yet",
      href: "/setup/connectors",
    });
    expect(rows.find((row) => row.key === "connectors")).toMatchObject({
      status: "not_set_up",
      statusLabel: "Not set up yet",
      href: "/setup/connectors",
    });
  });

  it("marks untested connectors and memory preparation as pending", () => {
    const rows = buildSetupHealthRows({
      ...baseSnapshot,
      connectors: { installed: 2, active: 2, tested: 1, withErrors: 0 },
      memory: {
        requested: true,
        disabled: false,
        embeddingConfigured: true,
        embeddingStatus: "reembedding",
        embeddingError: false,
      },
    });

    expect(rows.find((row) => row.key === "connectors")?.statusLabel).toBe("Pending/not checked");
    expect(rows.find((row) => row.key === "memory")?.statusLabel).toBe("Pending/not checked");
  });
});
