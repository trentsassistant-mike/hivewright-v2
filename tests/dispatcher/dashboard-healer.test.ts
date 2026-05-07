import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isDashboardCacheCorruption,
  probeDashboardRoutes,
  runDashboardHealerTick,
  type DashboardHealerDeps,
  type DashboardHealerState,
} from "@/dispatcher/dashboard-healer";

function responseFetch(statuses: Array<number | Error>): typeof fetch {
  let index = 0;
  return vi.fn(async () => {
    const next = statuses[Math.min(index, statuses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  }) as unknown as typeof fetch;
}

function createDeps(fetchImpl: typeof fetch): DashboardHealerDeps {
  return {
    fetch: fetchImpl,
    now: () => 1_000_000,
    logger: {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    runSystemctl: vi.fn(async () => {}),
    removeNextDir: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
  };
}

describe("dashboard healer", () => {
  it("treats 3+ canonical 404s as corrupted cache and triggers recovery", async () => {
    const deps = createDeps(responseFetch([404, 404, 404, 401, 200, 307, 401, 200]));
    const state: DashboardHealerState = { lastRecoveryAt: null, recovering: false };

    const result = await runDashboardHealerTick(deps, state, {
      recoveryWaitMs: 0,
      recoveryProbeIntervalMs: 0,
    });

    expect(result).toBe("recovered");
    expect(deps.runSystemctl).toHaveBeenNthCalledWith(1, "stop");
    expect(deps.removeNextDir).toHaveBeenCalledTimes(1);
    expect(deps.runSystemctl).toHaveBeenNthCalledWith(2, "start");
    expect(state.lastRecoveryAt).toBe(1_000_000);
  });

  it("does not trigger recovery for only 1-2 404s", async () => {
    const deps = createDeps(responseFetch([404, 404, 401, 200]));
    const state: DashboardHealerState = { lastRecoveryAt: null, recovering: false };

    const result = await runDashboardHealerTick(deps, state);

    expect(result).toBe("healthy");
    expect(deps.runSystemctl).not.toHaveBeenCalled();
    expect(deps.removeNextDir).not.toHaveBeenCalled();
  });

  it("rate limits a second recovery inside one hour and logs Tier 2 escalation", async () => {
    const deps = createDeps(responseFetch([404, 404, 404, 404]));
    const state: DashboardHealerState = {
      lastRecoveryAt: 1_000_000 - 30 * 60_000,
      recovering: false,
    };

    const result = await runDashboardHealerTick(deps, state);

    expect(result).toBe("rate-limited");
    expect(deps.runSystemctl).not.toHaveBeenCalled();
    expect(deps.removeNextDir).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("escalation=tier-2-owner-decision"),
    );
  });

  it("reports probe errors without classifying them as 404 corruption", async () => {
    const deps = createDeps(responseFetch([new Error("offline"), 404, 401, 200]));

    const results = await probeDashboardRoutes(deps);

    expect(results[0]).toMatchObject({ status: "error", ok: false });
    expect(isDashboardCacheCorruption(results)).toBe(false);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("probe-failure route=/login error=offline"),
    );
  });
});

describe("dashboard healer side-effect layer", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-healer-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("can exercise the systemctl + rm path against a throwaway .next directory", async () => {
    const nextDir = path.join(tmp, ".next");
    await fs.mkdir(nextDir);
    await fs.writeFile(path.join(nextDir, "stale-manifest.json"), "{}");
    const actions: string[] = [];
    const deps = createDeps(responseFetch([404, 404, 404, 404, 200, 307, 401, 200]));
    deps.runSystemctl = vi.fn(async (action) => {
      actions.push(`systemctl:${action}`);
    });
    deps.removeNextDir = vi.fn(async () => {
      actions.push("rm:.next");
      await fs.rm(nextDir, { recursive: true, force: true });
    });

    const state: DashboardHealerState = { lastRecoveryAt: null, recovering: false };
    const result = await runDashboardHealerTick(deps, state, {
      recoveryWaitMs: 0,
      recoveryProbeIntervalMs: 0,
    });

    await expect(fs.stat(nextDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result).toBe("recovered");
    expect(actions).toEqual(["systemctl:stop", "rm:.next", "systemctl:start"]);
  });
});
