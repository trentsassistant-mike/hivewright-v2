// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import HiveInitiativesPage from "../../src/app/(dashboard)/hives/[id]/initiatives/page";

let currentParams = { id: "hive-1" };
let currentPathname = "/hives/hive-1/initiatives";

vi.mock("next/navigation", () => ({
  useParams: () => currentParams,
  usePathname: () => currentPathname,
}));

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}

describe("HiveInitiativesPage", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    currentParams = { id: "hive-1" };
    currentPathname = "/hives/hive-1/initiatives";
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/api/initiative-runs?hiveId=hive-1") {
        return new Response(
          JSON.stringify({
            data: {
              runs: [
                {
                  id: "run-older",
                  trigger: "manual",
                  triggerRef: null,
                  status: "completed",
                  startedAt: "2026-04-20T09:00:00.000Z",
                  completedAt: "2026-04-20T09:05:00.000Z",
                  evaluatedCandidates: 2,
                  createdCount: 0,
                  suppressedCount: 1,
                  noopCount: 1,
                  runFailures: 0,
                  failureReason: null,
                  topSuppressionReasons: [{ reason: "cooldown_active", count: 1 }],
                },
                {
                  id: "run-newest",
                  trigger: "schedule",
                  triggerRef: "sched-123",
                  status: "completed",
                  startedAt: "2026-04-22T12:00:00.000Z",
                  completedAt: "2026-04-22T12:03:00.000Z",
                  evaluatedCandidates: 4,
                  createdCount: 1,
                  suppressedCount: 2,
                  noopCount: 1,
                  runFailures: 1,
                  failureReason: "one candidate submission failed",
                  topSuppressionReasons: [
                    { reason: "per_run_cap", count: 2 },
                    { reason: "queue_saturated", count: 1 },
                  ],
                },
              ],
            },
          }),
          { status: 200 },
        );
      }

      if (url === "/api/initiative-runs/run-newest?hiveId=hive-1") {
        return new Response(
          JSON.stringify({
            data: {
              run: {
                runId: "run-newest",
                id: "run-newest",
                trigger: "schedule",
                triggerRef: "sched-123",
                status: "completed",
                startedAt: "2026-04-22T12:00:00.000Z",
                completedAt: "2026-04-22T12:03:00.000Z",
                evaluatedCandidates: 4,
                createdCount: 1,
                suppressedCount: 2,
                noopCount: 1,
                runFailures: 1,
                failureReason: "one candidate submission failed",
                topSuppressionReasons: [
                  { reason: "per_run_cap", count: 2 },
                  { reason: "queue_saturated", count: 1 },
                ],
                decisions: [
                  {
                    id: "decision-1",
                    candidate_key: "dormant-goal-next-task:goal-1",
                    candidate_ref: "goal-1",
                    candidate_kind: "dormant-goal-next-task",
                    target_goal_id: "goal-1",
                    target_goal_title: "Recover onboarding flow",
                    action_taken: "create_task",
                    created_goal_id: null,
                    created_goal_title: null,
                    created_task_id: "task-1",
                    created_task_title: "Restart onboarding goal",
                    suppression_reason: null,
                    suppression_reasons: [],
                    rationale: "Created a fresh follow-up task for the dormant goal.",
                    classified_outcome: {
                      workItemType: "task",
                      classifiedRole: "dev-agent",
                      classification: {
                        provider: "test-provider",
                        model: "test-model",
                        confidence: 0.91,
                        reasoning: "task classification",
                        usedFallback: false,
                        role: "dev-agent",
                      },
                    },
                  },
                  {
                    id: "decision-2",
                    candidate_key: "promote-goal:goal-2",
                    candidate_ref: "goal-2",
                    candidate_kind: "promote-goal",
                    target_goal_id: "goal-2",
                    target_goal_title: "Refine retention dashboard",
                    action_taken: "create_goal",
                    created_goal_id: "goal-created-2",
                    created_goal_title: "Launch retention experiment goal",
                    created_task_id: null,
                    created_task_title: null,
                    suppression_reason: null,
                    suppression_reasons: [],
                    rationale: "Promoted the candidate into a standalone goal.",
                    classified_outcome: {
                      workItemType: "goal",
                      classifiedRole: "design-agent",
                      classification: {
                        provider: "legacy-provider",
                        confidence: 0.64,
                        reasoning: "Older payload omitted workItemType but still recorded the role.",
                      },
                    },
                  },
                  {
                    id: "decision-3",
                    candidate_key: "dormant-goal-next-task:goal-2",
                    candidate_ref: "goal-2",
                    candidate_kind: "dormant-goal-next-task",
                    target_goal_id: "goal-2",
                    target_goal_title: "Refine retention dashboard",
                    action_taken: "suppress",
                    created_goal_id: null,
                    created_goal_title: null,
                    created_task_id: null,
                    created_task_title: null,
                    suppression_reason: "per_run_cap",
                    suppression_reasons: ["per_run_cap", "queue_saturated"],
                    rationale: "Suppressed after this run hit the per-run cap.",
                    classified_outcome: null,
                  },
                ],
              },
            },
          }),
          { status: 200 },
        );
      }

      if (url === "/api/initiative-runs?hiveId=hive-1-empty") {
        return new Response(JSON.stringify({ data: { runs: [] } }), { status: 200 });
      }

      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders newest-first runs with metrics and drill-down details", async () => {
    renderWithQueryClient(<HiveInitiativesPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Initiatives" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Targets" }).getAttribute("href")).toBe("/hives/hive-1");
    expect(screen.getByRole("link", { name: "Initiatives" }).getAttribute("href")).toBe("/hives/hive-1/initiatives");
    expect(screen.getByText(/The initiative engine proposes candidates/i)).toBeTruthy();
    expect(screen.queryByText(/assignee/i)).toBeNull();
    expect(screen.queryByText(/role-assignee/i)).toBeNull();
    expect(screen.queryByText(/target role/i)).toBeNull();

    await screen.findByText(/Failure: one candidate submission failed/);
    expect(screen.getAllByText("Tasks created")).toHaveLength(2);
    expect(screen.queryByText("Work created")).toBeNull();
    const articles = screen.getAllByRole("article");
    expect(within(articles[0]).getByText("schedule sched-123")).toBeTruthy();
    expect(within(articles[1]).getByText("manual")).toBeTruthy();
    expect(within(articles[0]).getByText("4")).toBeTruthy();
    expect(within(articles[0]).getByText("2 / 1")).toBeTruthy();
    expect(within(articles[0]).getByText(/Failure: one candidate submission failed/)).toBeTruthy();
    expect(within(articles[0]).getByText("per run cap x2")).toBeTruthy();
    expect(within(articles[0]).getByText("queue saturated x1")).toBeTruthy();

    fireEvent.click(within(articles[0]).getByRole("button", { name: "View details" }));

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Recover onboarding flow" }).getAttribute("href")).toBe("/goals/goal-1"),
    );
    expect(screen.getByRole("link", { name: "Restart onboarding goal" }).getAttribute("href")).toBe("/tasks/task-1");
    expect(screen.getByRole("link", { name: "Launch retention experiment goal" }).getAttribute("href")).toBe("/goals/goal-created-2");
    expect(screen.getByText("per run cap")).toBeTruthy();
    expect(screen.getByText("queue saturated")).toBeTruthy();
    expect(screen.getAllByText("Created work")).toHaveLength(3);
    expect(screen.getAllByText("Classified outcome")).toHaveLength(3);
    expect(screen.getAllByText("Work item type:")).toHaveLength(3);
    expect(screen.getAllByText("Classified role:")).toHaveLength(3);
    expect(screen.getByText("Task", { exact: true })).toBeTruthy();
    expect(screen.getByText("Goal", { exact: true })).toBeTruthy();
    expect(screen.getByText("dev-agent")).toBeTruthy();
    expect(screen.getByText("design-agent")).toBeTruthy();
    expect(screen.getByText(/test-provider/i)).toBeTruthy();
    expect(screen.getByText(/task classification/i)).toBeTruthy();
    expect(screen.getByText(/Older payload omitted workItemType/i)).toBeTruthy();
    expect(screen.getAllByText("Not recorded").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Created a fresh follow-up task for the dormant goal.")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/initiative-runs/run-newest?hiveId=hive-1");
  });

  it("shows an empty state when the hive has no initiative runs", async () => {
    currentParams = { id: "hive-1-empty" };
    currentPathname = "/hives/hive-1-empty/initiatives";

    renderWithQueryClient(<HiveInitiativesPage />);

    await screen.findByText("No initiative runs yet for this hive.");
    expect(fetchMock).toHaveBeenCalledWith("/api/initiative-runs?hiveId=hive-1-empty");
  });
});
