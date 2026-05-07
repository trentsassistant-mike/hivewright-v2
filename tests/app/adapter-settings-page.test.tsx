// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdapterSettingsPage from "../../src/app/(dashboard)/settings/adapters/page";

const selectedHive = {
  id: "hive-1",
  slug: "hive-1",
  name: "Hive One",
  type: "digital",
};

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => ({
    hives: [selectedHive],
    selected: selectedHive,
    selectHive: vi.fn(),
    loading: false,
  }),
}));

describe("AdapterSettingsPage", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("offers GPT-5.5 in the adapter settings model picker", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/adapter-config")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/openclaw-detect")) {
        return jsonResponse({ data: { installed: false, endpoint: "", hasAuthToken: false } });
      }
      if (url.includes("/api/openclaw-config?agents=false")) {
        return jsonResponse({ data: null });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<AdapterSettingsPage />);

    await waitFor(() => expect(screen.getByText("Adapter Configuration")).toBeTruthy());
    const defaultModelSelect = screen.getByDisplayValue("Default (anthropic/claude-sonnet-4-6)") as HTMLSelectElement;
    const optionValues = Array.from(defaultModelSelect.options).map((option) => option.value);

    expect(optionValues).toContain("openai/gpt-5.5");
    expect(optionValues).toContain("mistral/mistral-large-latest");
    expect(optionValues).toContain("mistral/mistral-ocr-latest");
    expect(optionValues).toContain("google/gemini-3.1-pro-preview");
    expect(optionValues).toContain("google/gemini-3.1-pro-preview-customtools");
    expect(optionValues).toContain("google/gemini-3.1-flash-lite-preview");
    expect(optionValues).toContain("google/gemini-3-flash-preview");
    expect(optionValues).not.toContain("google/gemini-3.1-flash-live-preview");
  });

  it("runs adapter model discovery for the selected hive", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/adapter-config")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/openclaw-detect")) {
        return jsonResponse({ data: { installed: false, endpoint: "", hasAuthToken: false } });
      }
      if (url.includes("/api/openclaw-config?agents=false")) {
        return jsonResponse({ data: null });
      }
      if (url.includes("/api/model-setup/discover")) {
        return jsonResponse({
          data: {
            result: {
              modelsSeen: 4,
              modelsImported: 3,
              modelsAutoEnabled: 2,
              modelsMarkedStale: 1,
            },
          },
        });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<AdapterSettingsPage />);

    await screen.findByText("Adapter Configuration");
    fireEvent.click(screen.getByRole("button", { name: "Discover codex models" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/model-setup/discover",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("\"adapterType\":\"codex\""),
        }),
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/model-setup/discover",
      expect.objectContaining({
        body: expect.stringContaining("\"hiveId\":\"hive-1\""),
      }),
    );
    expect(await screen.findByText("4 seen, 3 imported, 2 enabled, 1 stale")).toBeTruthy();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
