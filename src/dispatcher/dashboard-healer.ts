import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DASHBOARD_HEALER_PREFIX = "[dashboard-healer]";

export interface DashboardProbeResult {
  route: string;
  status: number | "error";
  ok: boolean;
}

export interface DashboardHealerDeps {
  fetch: typeof fetch;
  now: () => number;
  logger: Pick<Console, "log" | "warn" | "error">;
  runSystemctl: (action: "stop" | "start") => Promise<void>;
  removeNextDir: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export interface DashboardHealerOptions {
  baseUrl?: string;
  routes?: string[];
  normalStatuses?: number[];
  corruption404Threshold?: number;
  recoveryCooldownMs?: number;
  recoveryWaitMs?: number;
  recoveryProbeIntervalMs?: number;
}

export interface DashboardHealerState {
  lastRecoveryAt: number | null;
  recovering: boolean;
}

const DEFAULT_ROUTES = ["/login", "/api/hives", "/api/brief", "/"];
const DEFAULT_NORMAL_STATUSES = [200, 307, 401];
const DEFAULT_OPTIONS = {
  baseUrl: "http://localhost:3002",
  routes: DEFAULT_ROUTES,
  normalStatuses: DEFAULT_NORMAL_STATUSES,
  corruption404Threshold: 3,
  recoveryCooldownMs: 60 * 60_000,
  recoveryWaitMs: 60_000,
  recoveryProbeIntervalMs: 5_000,
} satisfies Required<DashboardHealerOptions>;

export function createDefaultDashboardHealerDeps(): DashboardHealerDeps {
  const dashboardRoot = path.resolve(
    process.env.HIVEWRIGHT_DASHBOARD_ROOT ?? process.cwd(),
  );
  const nextDir = path.resolve(dashboardRoot, ".next");
  if (path.basename(nextDir) !== ".next" || path.dirname(nextDir) !== dashboardRoot) {
    throw new Error(`Refusing unsafe .next path: ${nextDir}`);
  }

  const systemctlBin = process.env.SYSTEMCTL_BIN ?? "systemctl";

  return {
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    logger: console,
    runSystemctl: async (action) => {
      await execFileAsync(systemctlBin, [
        "--user",
        action,
        "hivewrightv2-dashboard.service",
      ]);
    },
    removeNextDir: async () => {
      await fs.rm(nextDir, { recursive: true, force: true });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export async function probeDashboardRoutes(
  deps: Pick<DashboardHealerDeps, "fetch" | "logger">,
  options: DashboardHealerOptions = {},
): Promise<DashboardProbeResult[]> {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  const normalStatuses = new Set(merged.normalStatuses);

  const results = await Promise.all(
    merged.routes.map(async (route) => {
      try {
        const res = await deps.fetch(new URL(route, merged.baseUrl), {
          redirect: "manual",
        });
        const result = {
          route,
          status: res.status,
          ok: normalStatuses.has(res.status),
        };
        if (!result.ok) {
          deps.logger.warn(
            `${DASHBOARD_HEALER_PREFIX} probe-failure route=${route} status=${res.status}`,
          );
        }
        return result;
      } catch (err) {
        deps.logger.warn(
          `${DASHBOARD_HEALER_PREFIX} probe-failure route=${route} error=${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return { route, status: "error", ok: false } satisfies DashboardProbeResult;
      }
    }),
  );

  return results;
}

export function isDashboardCacheCorruption(
  results: DashboardProbeResult[],
  threshold = DEFAULT_OPTIONS.corruption404Threshold,
): boolean {
  return results.filter((result) => result.status === 404).length >= threshold;
}

export async function runDashboardHealerTick(
  deps: DashboardHealerDeps,
  state: DashboardHealerState,
  options: DashboardHealerOptions = {},
): Promise<"healthy" | "recovered" | "rate-limited" | "recovery-failed" | "already-recovering"> {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  if (state.recovering) return "already-recovering";

  const results = await probeDashboardRoutes(deps, merged);
  if (!isDashboardCacheCorruption(results, merged.corruption404Threshold)) {
    return "healthy";
  }

  const lastRecoveryAt = state.lastRecoveryAt;
  if (
    lastRecoveryAt !== null &&
    deps.now() - lastRecoveryAt < merged.recoveryCooldownMs
  ) {
    deps.logger.error(
      `${DASHBOARD_HEALER_PREFIX} rate-limit-skip signal=dashboard-cache-corruption lastRecoveryAt=${new Date(
        lastRecoveryAt,
      ).toISOString()} escalation=tier-2-owner-decision`,
    );
    return "rate-limited";
  }

  state.recovering = true;
  state.lastRecoveryAt = deps.now();
  deps.logger.error(
    `${DASHBOARD_HEALER_PREFIX} recovery-start signal=dashboard-cache-corruption routes404=${
      results.filter((result) => result.status === 404).length
    }`,
  );

  try {
    await deps.runSystemctl("stop");
    await deps.removeNextDir();
    await deps.runSystemctl("start");

    const ready = await waitForDashboardRecovery(deps, merged);
    if (!ready) {
      deps.logger.error(
        `${DASHBOARD_HEALER_PREFIX} recovery-failed reason=dashboard-not-ready timeoutMs=${merged.recoveryWaitMs}`,
      );
      return "recovery-failed";
    }

    deps.logger.log(`${DASHBOARD_HEALER_PREFIX} recovery-complete status=ready`);
    return "recovered";
  } catch (err) {
    deps.logger.error(
      `${DASHBOARD_HEALER_PREFIX} recovery-failed error=${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return "recovery-failed";
  } finally {
    state.recovering = false;
  }
}

async function waitForDashboardRecovery(
  deps: DashboardHealerDeps,
  options: Required<DashboardHealerOptions>,
): Promise<boolean> {
  const deadline = deps.now() + options.recoveryWaitMs;
  while (deps.now() <= deadline) {
    const results = await probeDashboardRoutes(deps, options);
    const normalCount = results.filter((result) => result.ok).length;
    if (normalCount >= options.corruption404Threshold) return true;
    await deps.sleep(options.recoveryProbeIntervalMs);
  }
  return false;
}
