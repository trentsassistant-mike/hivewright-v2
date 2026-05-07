// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DecisionsPage from "../../src/app/(dashboard)/decisions/page";

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => ({
    selected: { id: "hive-decisions", name: "Decision Hive" },
    loading: false,
  }),
}));

describe("DecisionsPage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/decisions?")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "decision-direct-qa",
                title: 'Task "Direct task QA cap" failed QA twice, what next?',
                context: "Direct task failed QA twice.",
                recommendation: "Choose how to recover this direct task.",
                options: {
                  kind: "direct_task_qa_cap_recovery",
                  options: [
                    { label: "Retry with a different role", action: "retry_with_different_role" },
                    { label: "Refine the brief and retry", action: "refine_brief_and_retry" },
                    { label: "Abandon this task", action: "abandon" },
                  ],
                },
                priority: "urgent",
                status: "pending",
                kind: "decision",
                createdAt: new Date().toISOString(),
              },
              {
                id: "decision-no-options",
                title: "Approve fallback decision?",
                context: "This decision has no named options.",
                recommendation: "Use the yes/no fallback.",
                options: [],
                priority: "normal",
                status: "pending",
                kind: "decision",
                createdAt: new Date().toISOString(),
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/decisions/decision-direct-qa/respond")) {
        const body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            data: {
              id: "decision-direct-qa",
              status: "resolved",
              ownerResponse: body.response,
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/decisions/decision-no-options/respond")) {
        const body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            data: {
              id: "decision-no-options",
              status: "resolved",
              ownerResponse: body.response,
            },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("renders direct QA-cap structured options as owner action buttons", async () => {
    render(<DecisionsPage />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry with a different role" })).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Refine the brief and retry" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Abandon this task" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Refine the brief and retry" }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/decisions/decision-direct-qa/respond",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            response: "refine_brief_and_retry",
            selectedOptionKey: "refine_brief_and_retry",
            selectedOptionLabel: "Refine the brief and retry",
          }),
        }),
      );
    });
  });

  it("keeps approve/reject fallback actions for decisions without options", async () => {
    render(<DecisionsPage />);

    await waitFor(() => {
      expect(screen.getByText("Approve fallback decision?")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/decisions/decision-no-options/respond",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ response: "approved" }),
        }),
      );
    });
  });
});
