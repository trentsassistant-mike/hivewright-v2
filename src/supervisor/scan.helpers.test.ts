import { describe, it, expect } from "vitest";
import { findingId, isTerminalVerificationTask, sortFindings } from "./scan";
import type { SupervisorFinding } from "./types";

/**
 * Pure-function tests for the scan core's identity + ordering helpers.
 *
 * These tests intentionally do NOT touch the DB — the whole point of
 * structured `findingId` and `sortFindings` is that they are
 * deterministic over their inputs. If you find yourself reaching for a
 * DB fixture here, the helper has leaked a side-effect and the fix is
 * in the helper, not the test.
 *
 * Key layout convention (see
 * docs/superpowers/research/2026-04-21-hive-supervisor-baseline.md
 * §"Dedupe"):
 *   <kind>:<primary-ref>[:<discriminator>...]
 *
 * The id doubles as the dedupe key: `(hiveId, finding.id)` uniquely
 * identifies a finding across supervisor heartbeats, which the applier
 * + supervisor_reports audit rely on.
 */

function finding(
  overrides: Partial<SupervisorFinding> & Pick<SupervisorFinding, "id" | "kind" | "severity">,
): SupervisorFinding {
  return {
    ref: {},
    summary: "",
    detail: {},
    ...overrides,
  };
}

describe("findingId", () => {
  it("produces the identical string for identical inputs", () => {
    const a = findingId("stalled_task", "task-123", "active");
    const b = findingId("stalled_task", "task-123", "active");
    expect(a).toBe(b);
    expect(a).toBe("stalled_task:task-123:active");
  });

  it("uses ':' as the separator between kind and each component", () => {
    expect(findingId("aging_decision", "dec-1")).toBe("aging_decision:dec-1");
    expect(findingId("recurring_failure", "dev-agent", "sig-abc")).toBe(
      "recurring_failure:dev-agent:sig-abc",
    );
  });

  it("distinguishes findings that differ only in the discriminator", () => {
    const active = findingId("stalled_task", "task-1", "active");
    const blocked = findingId("stalled_task", "task-1", "blocked");
    expect(active).not.toBe(blocked);
  });

  it("requires at least one key component so ids cannot collapse to just the kind", () => {
    expect(() => findingId("stalled_task")).toThrow(/at least one/i);
  });

  it("rejects empty string key components to avoid ambiguous ids like 'stalled_task::active'", () => {
    expect(() => findingId("stalled_task", "", "active")).toThrow(/empty/i);
  });

  it("rejects key components that contain the separator ':'", () => {
    expect(() => findingId("stalled_task", "task:with:colon")).toThrow(/:/);
  });
});

describe("sortFindings", () => {
  it("orders by severity: critical → warn → info", () => {
    const findings: SupervisorFinding[] = [
      finding({ id: "x:3", kind: "stalled_task", severity: "info" }),
      finding({ id: "x:1", kind: "stalled_task", severity: "warn" }),
      finding({ id: "x:2", kind: "stalled_task", severity: "critical" }),
    ];
    sortFindings(findings);
    expect(findings.map((f) => f.severity)).toEqual([
      "critical",
      "warn",
      "info",
    ]);
  });

  it("within the same severity, orders by kind alphabetically", () => {
    const findings: SupervisorFinding[] = [
      finding({ id: "a:1", kind: "stalled_task", severity: "warn" }),
      finding({ id: "a:2", kind: "aging_decision", severity: "warn" }),
      finding({ id: "a:3", kind: "recurring_failure", severity: "warn" }),
    ];
    sortFindings(findings);
    expect(findings.map((f) => f.kind)).toEqual([
      "aging_decision",
      "recurring_failure",
      "stalled_task",
    ]);
  });

  it("within the same severity + kind, orders by id alphabetically to fully break ties", () => {
    const findings: SupervisorFinding[] = [
      finding({ id: "stalled_task:b", kind: "stalled_task", severity: "warn" }),
      finding({ id: "stalled_task:a", kind: "stalled_task", severity: "warn" }),
      finding({ id: "stalled_task:c", kind: "stalled_task", severity: "warn" }),
    ];
    sortFindings(findings);
    expect(findings.map((f) => f.id)).toEqual([
      "stalled_task:a",
      "stalled_task:b",
      "stalled_task:c",
    ]);
  });

  it("is deterministic: two runs over the same input produce identical order", () => {
    const input: SupervisorFinding[] = [
      finding({ id: "stalled_task:t2:active", kind: "stalled_task", severity: "warn" }),
      finding({ id: "aging_decision:d1", kind: "aging_decision", severity: "critical" }),
      finding({ id: "stalled_task:t1:blocked", kind: "stalled_task", severity: "warn" }),
      finding({ id: "aging_decision:d2", kind: "aging_decision", severity: "warn" }),
    ];
    const a = input.map((f) => ({ ...f }));
    const b = input.map((f) => ({ ...f }));
    sortFindings(a);
    sortFindings(b);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
  });

  it("sorts in place and does not drop or duplicate findings", () => {
    const findings: SupervisorFinding[] = [
      finding({ id: "stalled_task:b", kind: "stalled_task", severity: "warn" }),
      finding({ id: "aging_decision:a", kind: "aging_decision", severity: "critical" }),
      finding({ id: "stalled_task:a", kind: "stalled_task", severity: "warn" }),
    ];
    const originalIds = new Set(findings.map((f) => f.id));
    sortFindings(findings);
    expect(findings).toHaveLength(3);
    expect(new Set(findings.map((f) => f.id))).toEqual(originalIds);
  });
});

describe("isTerminalVerificationTask", () => {
  it("matches proof-only verification tasks with explicit no-code instructions", () => {
    expect(
      isTerminalVerificationTask({
        title: "Plan 4 smoke test",
        brief:
          "Print the text `smoke test running`, then exit. Do not modify any files or run any other commands.",
        hasWorkProduct: false,
        failureReason: null,
      }),
    ).toBe(true);
  });

  it("matches audit/checklist verification tasks that are report-only", () => {
    expect(
      isTerminalVerificationTask({
        title: "Verify auth coverage: remaining goal mutation handlers",
        brief:
          "Audit those handlers and confirm coverage. Produce a concise implementation checklist with exact file paths. Do not modify application code.",
        hasWorkProduct: false,
        failureReason: null,
      }),
    ).toBe(true);
  });

  it("does not match verification tasks that may still need implementation", () => {
    expect(
      isTerminalVerificationTask({
        title: "Verify codex.ts check() fix is committed and build is clean",
        brief:
          "If NOT committed: apply the minimal fix in src/provisioning/codex.ts, then commit it and rerun build.",
        hasWorkProduct: false,
        failureReason: null,
      }),
    ).toBe(false);
  });

  it("still matches report-only verification tasks when the report is stored as a work product", () => {
    expect(
      isTerminalVerificationTask({
        title: "Plan 4 smoke test",
        brief:
          "Print the text `smoke test running`, then exit. Do not modify any files or run any other commands.",
        hasWorkProduct: true,
        failureReason: null,
      }),
    ).toBe(true);
  });

  it("does not match if the task carries failure metadata", () => {
    expect(
      isTerminalVerificationTask({
        title: "Plan 4 smoke test",
        brief:
          "Print the text `smoke test running`, then exit. Do not modify any files or run any other commands.",
        hasWorkProduct: false,
        failureReason: "adapter timeout",
      }),
    ).toBe(false);
  });
});
