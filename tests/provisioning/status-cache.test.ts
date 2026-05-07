import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  getCachedStatus,
  setCachedStatus,
  invalidate,
  invalidateAll,
  CACHE_TTL_MS,
} from "../../src/provisioning/status-cache";

beforeEach(() => {
  invalidateAll();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-17T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("provisioning/status-cache", () => {
  it("returns undefined on miss", () => {
    expect(getCachedStatus("foo")).toBeUndefined();
  });

  it("returns cached status before TTL expires", () => {
    setCachedStatus("foo", { satisfied: true, fixable: true });
    vi.advanceTimersByTime(CACHE_TTL_MS - 1);
    expect(getCachedStatus("foo")).toEqual({ satisfied: true, fixable: true });
  });

  it("returns undefined after TTL expires", () => {
    setCachedStatus("foo", { satisfied: true, fixable: true });
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);
    expect(getCachedStatus("foo")).toBeUndefined();
  });

  it("invalidate(slug) removes one entry", () => {
    setCachedStatus("foo", { satisfied: true, fixable: true });
    setCachedStatus("bar", { satisfied: true, fixable: true });
    invalidate("foo");
    expect(getCachedStatus("foo")).toBeUndefined();
    expect(getCachedStatus("bar")).toBeDefined();
  });

  it("invalidateAll() clears everything", () => {
    setCachedStatus("foo", { satisfied: true, fixable: true });
    setCachedStatus("bar", { satisfied: true, fixable: true });
    invalidateAll();
    expect(getCachedStatus("foo")).toBeUndefined();
    expect(getCachedStatus("bar")).toBeUndefined();
  });
});
