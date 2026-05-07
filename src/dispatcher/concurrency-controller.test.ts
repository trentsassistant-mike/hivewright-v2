import { describe, expect, it } from "vitest";
import {
  calculateDynamicConcurrencyCap,
  normalizeDynamicConcurrencyConfig,
  type LocalCapacitySnapshot,
} from "./concurrency-controller";

const relaxedSnapshot: LocalCapacitySnapshot = {
  cpuPercent: 24,
  memoryPercent: 48,
  gpuPercent: 20,
};

describe("dispatcher dynamic concurrency controller", () => {
  it("keeps the manual cap when auto concurrency is disabled", () => {
    const config = normalizeDynamicConcurrencyConfig({
      enabled: false,
      minConcurrentTasks: 1,
      maxConcurrentTasks: 12,
    });

    expect(calculateDynamicConcurrencyCap({
      manualMaxConcurrentTasks: 7,
      currentCap: 3,
      config,
      snapshot: {
        cpuPercent: 99,
        memoryPercent: 99,
        gpuPercent: 99,
      },
    })).toBe(7);
  });

  it("steps down when local pressure is above the high thresholds", () => {
    const config = normalizeDynamicConcurrencyConfig({
      enabled: true,
      minConcurrentTasks: 2,
      maxConcurrentTasks: 10,
      step: 2,
      cpuHighPercent: 85,
      memoryHighPercent: 88,
      gpuHighPercent: 90,
    });

    expect(calculateDynamicConcurrencyCap({
      manualMaxConcurrentTasks: 10,
      currentCap: 8,
      config,
      snapshot: {
        cpuPercent: 91,
        memoryPercent: 64,
        gpuPercent: 30,
      },
    })).toBe(6);
  });

  it("does not step below the configured minimum", () => {
    const config = normalizeDynamicConcurrencyConfig({
      enabled: true,
      minConcurrentTasks: 2,
      maxConcurrentTasks: 10,
      step: 4,
      cpuHighPercent: 85,
    });

    expect(calculateDynamicConcurrencyCap({
      manualMaxConcurrentTasks: 10,
      currentCap: 3,
      config,
      snapshot: {
        cpuPercent: 98,
        memoryPercent: 30,
      },
    })).toBe(2);
  });

  it("steps up when all measured resources are below the low thresholds", () => {
    const config = normalizeDynamicConcurrencyConfig({
      enabled: true,
      minConcurrentTasks: 1,
      maxConcurrentTasks: 8,
      step: 2,
      cpuLowPercent: 45,
      memoryLowPercent: 60,
      gpuLowPercent: 40,
    });

    expect(calculateDynamicConcurrencyCap({
      manualMaxConcurrentTasks: 8,
      currentCap: 4,
      config,
      snapshot: relaxedSnapshot,
    })).toBe(6);
  });

  it("never exceeds the smaller of the manual cap and auto max", () => {
    const config = normalizeDynamicConcurrencyConfig({
      enabled: true,
      minConcurrentTasks: 1,
      maxConcurrentTasks: 12,
      step: 5,
      cpuLowPercent: 45,
      memoryLowPercent: 60,
      gpuLowPercent: 40,
    });

    expect(calculateDynamicConcurrencyCap({
      manualMaxConcurrentTasks: 6,
      currentCap: 4,
      config,
      snapshot: relaxedSnapshot,
    })).toBe(6);
  });
});
