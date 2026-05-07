// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import QualityFeedbackPage from "../../src/app/(dashboard)/quality-feedback/page";

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mocks.searchParams,
}));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => ({
    selected: { id: "hive-quality", name: "Quality Hive" },
    hives: [{ id: "hive-quality", name: "Quality Hive" }],
    loading: false,
  }),
}));

describe("QualityFeedbackPage QA fixture lane", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mocks.searchParams = new URLSearchParams();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/decisions?")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("loads owner-facing quality feedback without QA fixture params by default", async () => {
    render(<QualityFeedbackPage />);

    await waitFor(() => expect(screen.getByText("No quality feedback is waiting.")).toBeTruthy());

    const urls = vi.mocked(globalThis.fetch).mock.calls.map((call) => String(call[0]));
    expect(urls).toHaveLength(2);
    expect(urls.every((url) => !url.includes("qaFixtures=true"))).toBe(true);
    expect(urls.every((url) => !url.includes("qaRunId="))).toBe(true);
  });

  it("loads only the named QA fixture run when qaRunId is present", async () => {
    mocks.searchParams = new URLSearchParams({ qaRunId: "qa-smoke-page" });

    render(<QualityFeedbackPage />);

    await waitFor(() => expect(screen.getByText("No quality feedback is waiting.")).toBeTruthy());

    const urls = vi.mocked(globalThis.fetch).mock.calls.map((call) => String(call[0]));
    expect(urls).toHaveLength(2);
    expect(urls.every((url) => url.includes("qaFixtures=true"))).toBe(true);
    expect(urls.every((url) => url.includes("qaRunId=qa-smoke-page"))).toBe(true);
  });
});
