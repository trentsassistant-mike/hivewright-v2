/**
 * Focused tests for summarizeSupervisorReport — the pure mapper that
 * /api/brief uses to collapse a supervisor_reports row into the thin
 * { findings, actionsEmitted, actionsApplied } shape. The DB-backed
 * /api/brief integration test in tests/app/api/brief-supervisor.test.ts
 * already exercises the end-to-end wiring; this file locks in the
 * counting rules so future changes to the summarizer must stay
 * consistent with the full-detail /api/supervisor-reports view.
 */
import { describe, it, expect } from "vitest";
import {
  summarizeSupervisorReport,
  type SupervisorReportRow,
} from "./queries";

function row(overrides: Partial<SupervisorReportRow> = {}): SupervisorReportRow {
  return {
    id: "r-1",
    hiveId: "11111111-1111-1111-1111-111111111111",
    ranAt: new Date("2026-04-21T00:00:00.000Z"),
    report: { findings: [] },
    actions: { summary: "", findings_addressed: [], actions: [] },
    actionOutcomes: [],
    agentTaskId: null,
    freshInputTokens: null,
    cachedInputTokens: null,
    cachedInputTokensKnown: false,
    totalContextTokens: null,
    estimatedBillableCostCents: null,
    tokensInput: null,
    tokensOutput: null,
    costCents: null,
    ...overrides,
  };
}

describe("summarizeSupervisorReport", () => {
  it("returns null when no row is provided", () => {
    expect(summarizeSupervisorReport(null)).toBeNull();
  });

  it("counts findings, emitted actions, and applied actions", () => {
    const summary = summarizeSupervisorReport(
      row({
        report: {
          findings: [
            { id: "f1" },
            { id: "f2" },
            { id: "f3" },
          ],
        },
        actions: {
          actions: [
            { kind: "wake_goal" },
            { kind: "noop" },
            { kind: "create_decision" },
          ],
        },
        actionOutcomes: [
          { status: "applied" },
          { status: "skipped" },
          { status: "applied" },
        ],
      }),
    );
    expect(summary).toEqual({
      id: "r-1",
      ranAt: new Date("2026-04-21T00:00:00.000Z"),
      findings: 3,
      actionsEmitted: 3,
      actionsApplied: 2,
    });
  });

  it("treats null actions + null outcomes as zeros (agent never returned)", () => {
    const summary = summarizeSupervisorReport(
      row({
        report: { findings: [{ id: "f1" }] },
        actions: null,
        actionOutcomes: null,
      }),
    );
    expect(summary).toMatchObject({
      findings: 1,
      actionsEmitted: 0,
      actionsApplied: 0,
    });
  });

  it("falls back to outcomes.length for actionsEmitted when actions blob is malformed", () => {
    // Mirrors the malformed-output escalation path: action_outcomes is
    // populated with a single error entry, but the actions column was
    // never filled because the JSON was unparseable.
    const summary = summarizeSupervisorReport(
      row({
        actions: null,
        actionOutcomes: [{ status: "error" }],
      }),
    );
    expect(summary?.actionsEmitted).toBe(1);
    expect(summary?.actionsApplied).toBe(0);
  });

  it("tolerates a report with no findings array", () => {
    const summary = summarizeSupervisorReport(
      row({ report: {}, actions: null, actionOutcomes: null }),
    );
    expect(summary?.findings).toBe(0);
  });
});
