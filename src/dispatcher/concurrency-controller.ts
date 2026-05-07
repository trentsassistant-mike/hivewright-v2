import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DynamicConcurrencyConfig {
  enabled: boolean;
  minConcurrentTasks: number;
  maxConcurrentTasks: number;
  step: number;
  cpuHighPercent: number;
  cpuLowPercent: number;
  memoryHighPercent: number;
  memoryLowPercent: number;
  gpuHighPercent: number;
  gpuLowPercent: number;
}

export interface LocalCapacitySnapshot {
  cpuPercent: number;
  memoryPercent: number;
  gpuPercent?: number;
}

export const DEFAULT_DYNAMIC_CONCURRENCY_CONFIG: DynamicConcurrencyConfig = {
  enabled: false,
  minConcurrentTasks: 1,
  maxConcurrentTasks: 8,
  step: 1,
  cpuHighPercent: 85,
  cpuLowPercent: 45,
  memoryHighPercent: 85,
  memoryLowPercent: 65,
  gpuHighPercent: 90,
  gpuLowPercent: 50,
};

export function normalizeDynamicConcurrencyConfig(value: unknown): DynamicConcurrencyConfig {
  if (!value || typeof value !== "object") {
    return DEFAULT_DYNAMIC_CONCURRENCY_CONFIG;
  }

  const raw = value as Record<string, unknown>;
  const minConcurrentTasks = clampInt(raw.minConcurrentTasks, 1, 100, DEFAULT_DYNAMIC_CONCURRENCY_CONFIG.minConcurrentTasks);
  const maxConcurrentTasks = Math.max(
    minConcurrentTasks,
    clampInt(raw.maxConcurrentTasks, 1, 100, DEFAULT_DYNAMIC_CONCURRENCY_CONFIG.maxConcurrentTasks),
  );

  return {
    enabled: raw.enabled === true,
    minConcurrentTasks,
    maxConcurrentTasks,
    step: clampInt(raw.step, 1, 20, DEFAULT_DYNAMIC_CONCURRENCY_CONFIG.step),
    cpuHighPercent: clampPercent(raw.cpuHighPercent, DEFAULT_DYNAMIC_CONCURRENCY_CONFIG.cpuHighPercent),
    cpuLowPercent: clampPercent(raw.cpuLowPercent, DEFAULT_DYNAMIC_CONCURRENCY_CONFIG.cpuLowPercent),
    memoryHighPercent: clampPercent(raw.memoryHighPercent, DEFAULT_DYNAMIC_CONCURRENCY_CONFIG.memoryHighPercent),
    memoryLowPercent: clampPercent(raw.memoryLowPercent, DEFAULT_DYNAMIC_CONCURRENCY_CONFIG.memoryLowPercent),
    gpuHighPercent: clampPercent(raw.gpuHighPercent, DEFAULT_DYNAMIC_CONCURRENCY_CONFIG.gpuHighPercent),
    gpuLowPercent: clampPercent(raw.gpuLowPercent, DEFAULT_DYNAMIC_CONCURRENCY_CONFIG.gpuLowPercent),
  };
}

export function calculateDynamicConcurrencyCap(input: {
  manualMaxConcurrentTasks: number;
  currentCap: number | null | undefined;
  config: DynamicConcurrencyConfig;
  snapshot: LocalCapacitySnapshot;
}): number {
  const manualCap = clampInt(input.manualMaxConcurrentTasks, 1, 100, 1);
  if (!input.config.enabled) return manualCap;

  const floor = Math.min(input.config.minConcurrentTasks, manualCap);
  const ceiling = Math.max(floor, Math.min(input.config.maxConcurrentTasks, manualCap));
  const current = clampInt(input.currentCap, floor, ceiling, manualCap);

  if (isHighPressure(input.snapshot, input.config)) {
    return Math.max(floor, current - input.config.step);
  }

  if (isLowPressure(input.snapshot, input.config)) {
    return Math.min(ceiling, current + input.config.step);
  }

  return current;
}

export async function readLocalCapacitySnapshot(): Promise<LocalCapacitySnapshot> {
  const cpus = os.cpus().length || 1;
  const cpuPercent = clampNumber((os.loadavg()[0] / cpus) * 100, 0, 100);
  const totalMem = os.totalmem();
  const usedMem = totalMem > 0 ? totalMem - os.freemem() : 0;
  const memoryPercent = totalMem > 0 ? clampNumber((usedMem / totalMem) * 100, 0, 100) : 0;
  const gpuPercent = await readNvidiaGpuPercent();

  return gpuPercent === undefined
    ? { cpuPercent, memoryPercent }
    : { cpuPercent, memoryPercent, gpuPercent };
}

function isHighPressure(snapshot: LocalCapacitySnapshot, config: DynamicConcurrencyConfig): boolean {
  return snapshot.cpuPercent >= config.cpuHighPercent
    || snapshot.memoryPercent >= config.memoryHighPercent
    || (snapshot.gpuPercent !== undefined && snapshot.gpuPercent >= config.gpuHighPercent);
}

function isLowPressure(snapshot: LocalCapacitySnapshot, config: DynamicConcurrencyConfig): boolean {
  const measured = [
    snapshot.cpuPercent <= config.cpuLowPercent,
    snapshot.memoryPercent <= config.memoryLowPercent,
  ];
  if (snapshot.gpuPercent !== undefined) {
    measured.push(snapshot.gpuPercent <= config.gpuLowPercent);
  }
  return measured.every(Boolean);
}

async function readNvidiaGpuPercent(): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      [
        "--query-gpu=utilization.gpu,utilization.memory",
        "--format=csv,noheader,nounits",
      ],
      { timeout: 1_000 },
    );
    const samples = stdout
      .trim()
      .split(/\r?\n/)
      .flatMap((line) => line.split(",").map((part) => Number(part.trim())))
      .filter((value) => Number.isFinite(value));
    if (samples.length === 0) return undefined;
    return clampNumber(Math.max(...samples), 0, 100);
  } catch {
    return undefined;
  }
}

function clampPercent(value: unknown, fallback: number): number {
  return clampInt(value, 1, 100, fallback);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
