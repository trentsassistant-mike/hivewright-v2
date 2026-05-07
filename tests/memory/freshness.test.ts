import { describe, it, expect } from "vitest";
import { computeFreshness, formatWithFreshness } from "@/memory/freshness";

describe("computeFreshness", () => {
  it("returns fresh for entries updated within 30 days", () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 5);
    expect(computeFreshness(recent)).toBe("fresh");
  });

  it("returns aging for entries updated 30-90 days ago", () => {
    const aging = new Date();
    aging.setDate(aging.getDate() - 60);
    expect(computeFreshness(aging)).toBe("aging");
  });

  it("returns stale for entries updated over 90 days ago", () => {
    const stale = new Date();
    stale.setDate(stale.getDate() - 120);
    expect(computeFreshness(stale)).toBe("stale");
  });
});

describe("formatWithFreshness", () => {
  it("returns content as-is for fresh entries", () => {
    const recent = new Date();
    expect(formatWithFreshness("API rate limit is 60/min", recent)).toBe("API rate limit is 60/min");
  });

  it("appends aging note for entries 30-90 days old", () => {
    const aging = new Date();
    aging.setDate(aging.getDate() - 45);
    const result = formatWithFreshness("Easter is busy season", aging);
    expect(result).toContain("Easter is busy season");
    expect(result).toMatch(/last updated \d+ days ago/);
  });

  it("appends stale warning for entries over 90 days old", () => {
    const stale = new Date();
    stale.setDate(stale.getDate() - 150);
    const result = formatWithFreshness("Competitor pricing at $48/night", stale);
    expect(result).toContain("potentially outdated");
    expect(result).toMatch(/last updated \d+ days ago/);
  });
});
