import { describe, expect, it } from "vitest";
import { getAiBudgetWindowStart, normalizeAiBudgetSettings } from "@/budget/ai-budget-policy";

describe("AI spend budget policy settings", () => {
  it("normalizes per-hive caps and supported time windows", () => {
    expect(normalizeAiBudgetSettings({ capCents: 12_345, window: "monthly" })).toEqual({
      capCents: 12_345,
      window: "monthly",
    });

    expect(normalizeAiBudgetSettings({ capCents: -1, window: "nonsense" })).toMatchObject({
      capCents: 100_000,
      window: "all_time",
    });
  });

  it("derives bounded window starts for recurring hive budgets", () => {
    const now = new Date("2026-05-15T07:30:00.000Z");

    expect(getAiBudgetWindowStart("daily", now)?.toISOString()).toBe("2026-05-15T00:00:00.000Z");
    expect(getAiBudgetWindowStart("weekly", now)?.toISOString()).toBe("2026-05-11T00:00:00.000Z");
    expect(getAiBudgetWindowStart("monthly", now)?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(getAiBudgetWindowStart("all_time", now)).toBeNull();
  });
});
