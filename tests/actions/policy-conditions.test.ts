import { describe, expect, it } from "vitest";
import {
  conditionsMatchAction,
  type ActionPolicyConditions,
} from "@/actions/policy-conditions";

function matches(
  conditions: ActionPolicyConditions,
  args: Record<string, unknown>,
  extra: Partial<Parameters<typeof conditionsMatchAction>[0]> = {},
) {
  return conditionsMatchAction({
    conditions,
    args,
    now: new Date("2026-05-12T11:00:00"),
    riskTier: "medium",
    ...extra,
  });
}

describe("conditionsMatchAction", () => {
  it("matches amounts at or below the configured threshold", () => {
    expect(matches({ maxAmount: 100, amountField: "total" }, { total: 100 })).toBe(true);
    expect(matches({ maxAmount: 100, amountField: "total" }, { total: 101 })).toBe(false);
  });

  it("matches exact allowed destinations from a configured field", () => {
    expect(matches(
      { destinationField: "to", allowedDestinations: ["ops@example.com"] },
      { to: "ops@example.com" },
    )).toBe(true);
    expect(matches(
      { destinationField: "to", allowedDestinations: ["ops@example.com"] },
      { to: "finance@example.com" },
    )).toBe(false);
  });

  it("matches allowed email domains from the destination field", () => {
    expect(matches(
      { destinationField: "to", allowedDomains: ["example.com"] },
      { to: "Owner <owner@example.com>" },
    )).toBe(true);
    expect(matches(
      { destinationField: "to", allowedDomains: ["example.com"] },
      { to: "owner@other.test" },
    )).toBe(false);
  });

  it("restricts matches to weekday business hours when requested", () => {
    expect(matches(
      { businessHoursOnly: true },
      {},
      { now: new Date("2026-05-12T10:30:00") },
    )).toBe(true);
    expect(matches(
      { businessHoursOnly: true },
      {},
      { now: new Date("2026-05-12T19:00:00") },
    )).toBe(false);
    expect(matches(
      { businessHoursOnly: true },
      {},
      { now: new Date("2026-05-16T10:30:00") },
    )).toBe(false);
  });

  it("requires explicit dry-run args when configured", () => {
    expect(matches({ requireDryRun: true }, { dryRun: true })).toBe(true);
    expect(matches({ requireDryRun: true }, { dry_run: true })).toBe(true);
    expect(matches({ requireDryRun: true }, { dryRun: false })).toBe(false);
  });

  it("bounds matching by operation risk tier", () => {
    expect(matches({ riskTierAtMost: "high" }, {}, { riskTier: "medium" })).toBe(true);
    expect(matches({ riskTierAtMost: "medium" }, {}, { riskTier: "high" })).toBe(false);
  });
});
