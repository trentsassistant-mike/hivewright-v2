// @vitest-environment jsdom
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));

vi.mock("@/app/api/_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
}));

vi.mock("@/components/live-activity-panel", () => ({
  LiveActivityPanel: () => <div>Live activity</div>,
}));

vi.mock("@/components/attachments-panel", () => ({
  AttachmentsPanel: () => <div>Attachments</div>,
}));

vi.mock("@/components/task-pipeline-router", () => ({
  TaskPipelineRouter: () => <div>Task pipeline</div>,
}));

vi.mock("@/runtime-diagnostics/codex-empty-output", () => ({
  readLatestCodexEmptyOutputDiagnostic: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/provenance/task-context", () => ({
  readLatestTaskContextProvenance: vi.fn().mockResolvedValue({
    disclaimer: "Recorded task context sources.",
    status: "none",
    entries: [],
  }),
}));

import TaskDetailPage from "../../src/app/(dashboard)/tasks/[id]/page";

type TaskDetailTestRow = {
  id: string;
  hive_id: string;
  assigned_to: string;
  created_by: string;
  status: string;
  priority: number;
  title: string;
  brief: string;
  goal_id: string | null;
  sprint_number: number | null;
  qa_required: boolean;
  acceptance_criteria: string | null;
  result_summary: string | null;
  retry_count: number;
  doctor_attempts: number;
  failure_reason: string | null;
  usage_details: unknown;
  tokens_input: number | null;
  tokens_output: number | null;
  cost_cents: number | null;
  model_used: string | null;
  goal_budget_cents: number | null;
  goal_spent_cents: number | null;
  goal_budget_state: "ok" | "warning" | "paused" | "hard_stopped" | null;
  goal_budget_warning_triggered_at: Date | null;
  goal_budget_enforced_at: Date | null;
  goal_budget_enforcement_reason: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const baseTaskRow: TaskDetailTestRow = {
  id: "task-1",
  hive_id: "hive-1",
  assigned_to: "dev-agent",
  created_by: "owner",
  status: "active",
  priority: 1,
  title: "Task detail budget proof",
  brief: "Show AI usage proof on the canonical task detail page.",
  goal_id: "goal-1",
  sprint_number: 12,
  qa_required: false,
  acceptance_criteria: "Visible budget telemetry",
  result_summary: null,
  retry_count: 0,
  doctor_attempts: 0,
  failure_reason: null,
  usage_details: {
    totalInputTokens: 3200,
    freshInputTokens: 2400,
    outputTokens: 640,
    cacheReadTokens: 800,
    cacheCreationTokens: 120,
    estimatedBillableCostCents: 37,
    cachedInputTokensKnown: true,
  },
  tokens_input: 3200,
  tokens_output: 640,
  cost_cents: 37,
  model_used: "gpt-5.5",
  goal_budget_cents: 1000,
  goal_spent_cents: 400,
  goal_budget_state: "ok",
  goal_budget_warning_triggered_at: null,
  goal_budget_enforced_at: null,
  goal_budget_enforcement_reason: null,
  started_at: new Date("2026-05-13T00:00:00Z"),
  completed_at: null,
  created_at: new Date("2026-05-12T23:00:00Z"),
  updated_at: new Date("2026-05-13T00:00:00Z"),
};

function writeArtifact(name: string) {
  const artifactDir = process.env.TASK_DETAIL_BUDGET_ARTIFACT_DIR;
  if (!artifactDir) return;
  mkdirSync(artifactDir, { recursive: true });
  const html = `<!doctype html>\n<html><body>${document.body.innerHTML}</body></html>\n`;
  writeFileSync(path.join(artifactDir, `${name}.html`), html, "utf8");
}

async function renderPage(
  taskOverrides: Partial<TaskDetailTestRow> = {},
  artifactName?: string,
) {
  mocks.sql.mockResolvedValueOnce([{ ...baseTaskRow, ...taskOverrides }]);
  mocks.sql.mockResolvedValueOnce([]);
  render(await TaskDetailPage({ params: Promise.resolve({ id: "task-1" }) }));
  if (artifactName) writeArtifact(artifactName);
}

describe("TaskDetailPage AI budget proof", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("qualifies task columns in the joined task query", async () => {
    await renderPage();

    const [queryParts] = mocks.sql.mock.calls[0] ?? [];
    const queryText = Array.from(queryParts ?? []).join(" ");

    expect(queryText).toContain("SELECT t.id, t.hive_id");
    expect(queryText).toContain("FROM tasks t");
    expect(queryText).toContain("LEFT JOIN goals g ON g.id = t.goal_id");
    expect(queryText).not.toMatch(/SELECT\s+id,\s+hive_id/);
  });

  it("renders a normal budget state with cap, spend, remaining, and task usage proof", async () => {
    await renderPage({}, "normal");

    expect(screen.getByText("AI Usage")).toBeTruthy();
    expect(screen.getByText("Normal")).toBeTruthy();
    expect(screen.getByText("$10.00")).toBeTruthy();
    expect(screen.getByText("$4.00")).toBeTruthy();
    expect(screen.getByText("$6.00")).toBeTruthy();
    expect(screen.getAllByText("40% used").length).toBeGreaterThan(0);
    expect(screen.getByText("3,200")).toBeTruthy();
    expect(screen.getByText("640")).toBeTruthy();
    expect(screen.getByText("800")).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
  });

  it("renders the warning budget state explicitly", async () => {
    await renderPage({
      goal_spent_cents: 850,
      goal_budget_state: "warning",
      goal_budget_warning_triggered_at: new Date("2026-05-13T00:05:00Z"),
      updated_at: new Date("2026-05-13T00:05:00Z"),
    }, "warning");

    expect(screen.getByText("Warning")).toBeTruthy();
    expect(screen.getByText("$8.50")).toBeTruthy();
    expect(screen.getByText("$1.50")).toBeTruthy();
    expect(screen.getAllByText("85% used").length).toBeGreaterThan(0);
    expect(screen.getByText(/approaching the AI budget cap/i)).toBeTruthy();
  });

  it("renders the paused budget state with the persisted pause reason", async () => {
    await renderPage({
      status: "paused",
      goal_spent_cents: 1200,
      goal_budget_state: "paused",
      goal_budget_warning_triggered_at: new Date("2026-05-13T00:05:00Z"),
      goal_budget_enforced_at: new Date("2026-05-13T00:10:00Z"),
      goal_budget_enforcement_reason: "Paused by budget",
      updated_at: new Date("2026-05-13T00:10:00Z"),
    }, "paused");

    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText("$12.00")).toBeTruthy();
    expect(screen.getByText("$0.00")).toBeTruthy();
    expect(screen.getAllByText("120% used").length).toBeGreaterThan(0);
    expect(screen.getByText(/new AI work is paused/i)).toBeTruthy();
    expect(screen.getByText(/paused by budget/i)).toBeTruthy();
  });
});
