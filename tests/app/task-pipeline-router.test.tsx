// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskPipelineRouter } from "../../src/components/task-pipeline-router";

describe("TaskPipelineRouter", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("lets a supervisor start an approved business procedure for process-bound work", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/pipelines") && !init) {
        return new Response(JSON.stringify({
          data: {
            templates: [
              {
                id: "template-product",
                name: "Product Build Procedure",
                department: "product",
                description: "Scope, build, QA, ship.",
                scope: "hive",
                active: true,
                stepCount: 5,
                steps: [{ id: "step-1", name: "Scope", roleSlug: "research-analyst", order: 1 }],
              },
            ],
            runs: [],
          },
        }), { status: 200 });
      }
      if (url.endsWith("/api/pipelines") && init?.method === "POST") {
        return new Response(JSON.stringify({ data: { runId: "run-1", taskId: "task-next", stepRunId: "step-run-1" } }), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<TaskPipelineRouter hiveId="hive-1" taskId="source-task-1" taskTitle="Build intake form" />);

    await screen.findByText("Product Build Procedure · 5 steps");
    expect(screen.getByText("Business procedures")).toBeTruthy();
    expect(screen.getAllByText(/mandatory owner process/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/approved repeatable procedure/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/suggested drafts are candidates only/i)).toBeTruthy();
    expect(screen.queryByText(/choose a workflow path/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Start procedure" }));

    await waitFor(() => expect(screen.getByText(/Business procedure started/i)).toBeTruthy());
    const calls = vi.mocked(globalThis.fetch).mock.calls;
    const postCall = calls.find((call) => String(call[0]).endsWith("/api/pipelines") && call[1]?.method === "POST");
    expect(postCall).toBeTruthy();
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      hiveId: "hive-1",
      templateId: "template-product",
      sourceTaskId: "source-task-1",
    });
  });

  it("blocks duplicate routing when the source task already has an active run", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: {
        templates: [
          {
            id: "template-product",
            name: "Product Build Procedure",
            department: "product",
            description: null,
            scope: "hive",
            active: true,
            stepCount: 5,
            steps: [],
          },
        ],
        runs: [
          {
            id: "run-active",
            status: "active",
            sourceTaskId: "source-task-1",
            templateName: "Product Build Procedure",
            currentStepName: "Build",
          },
        ],
      },
    }), { status: 200 })) as unknown as typeof globalThis.fetch;

    render(<TaskPipelineRouter hiveId="hive-1" taskId="source-task-1" taskTitle="Build intake form" />);

    await screen.findByText(/Already routed through/i);
    const button = screen.getByRole("button", { name: "Start procedure" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/current step: Build/i)).toBeTruthy();
  });
});
