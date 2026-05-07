// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsPage from "../../src/app/(dashboard)/settings/page";
import {
  DEFAULT_EA_REPLAY_MESSAGE_LIMIT,
  EA_REPLAY_ADAPTER_TYPE,
  EA_REPLAY_MESSAGE_LIMIT_KEY,
  MAX_EA_REPLAY_MESSAGE_LIMIT,
  MIN_EA_REPLAY_MESSAGE_LIMIT,
} from "@/ea/replay-settings";

const hiveContext = vi.hoisted(() => ({
  selected: null as null | { id: string; name: string },
  hives: [] as { id: string; name: string }[],
}));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => ({
    hives: hiveContext.hives,
    selected: hiveContext.selected,
    selectHive: vi.fn(),
    loading: false,
  }),
}));

describe("SettingsPage EA replay settings", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    hiveContext.selected = null;
    hiveContext.hives = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("shows a bounded positive-integer replay window input with the default value", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/adapter-config")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/credentials")) {
        return jsonResponse({ data: [] });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<SettingsPage />);

    const input = (await screen.findByDisplayValue(
      String(DEFAULT_EA_REPLAY_MESSAGE_LIMIT),
    )) as HTMLInputElement;

    expect(screen.getByText("EA replay window (messages)")).toBeTruthy();
    expect(input.type).toBe("number");
    expect(input.min).toBe(String(MIN_EA_REPLAY_MESSAGE_LIMIT));
    expect(input.max).toBe(String(MAX_EA_REPLAY_MESSAGE_LIMIT));
    expect(input.step).toBe("1");
    expect(screen.getByText(/Whole number from 1 to 500; defaults to 80/i)).toBeTruthy();
  });

  it("saves an explicit configured replay window to adapter_config", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/adapter-config") && init?.method === "POST") {
        return jsonResponse({ data: { id: "cfg-1", updated: true } });
      }
      if (url.includes("/api/adapter-config")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/credentials")) {
        return jsonResponse({ data: [] });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<SettingsPage />);

    const input = (await screen.findByDisplayValue("80")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Save EA replay settings" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/adapter-config",
        expect.objectContaining({ method: "POST" }),
      );
    });
    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/adapter-config" && init?.method === "POST",
    );
    expect(postCall).toBeDefined();
    expect(JSON.parse(postCall?.[1]?.body as string)).toEqual({
      adapterType: EA_REPLAY_ADAPTER_TYPE,
      config: { [EA_REPLAY_MESSAGE_LIMIT_KEY]: 120 },
    });
  });

  it("renders and saves effective owner-feedback sampling through the quality config API", async () => {
    hiveContext.selected = { id: "hive-1", name: "Hive One" };
    hiveContext.hives = [hiveContext.selected];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/quality/config") && init?.method === "PATCH") {
        return jsonResponse({
          data: {
            source: "hive",
            effective: {
              owner_feedback_sample_rate: 0.08,
              ai_peer_feedback_sample_rate: 0.15,
            },
          },
        });
      }
      if (url.includes("/api/quality/config")) {
        return jsonResponse({
          data: {
            source: "hive",
            effective: {
              owner_feedback_sample_rate: 0.08,
              ai_peer_feedback_sample_rate: 0.1,
            },
          },
        });
      }
      if (url.includes("/api/quality/roles")) {
        return jsonResponse({
          data: {
            defaultQualityFloor: 0.7,
            roleQualityFloors: {},
            roles: [],
          },
        });
      }
      if (url.includes("/api/adapter-config")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/credentials")) {
        return jsonResponse({ data: [] });
      }
      if (url.includes("/api/notifications/preferences")) {
        return jsonResponse({ data: [] });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    render(<SettingsPage />);

    const aiPeerInput = (await screen.findByDisplayValue("0.1")) as HTMLInputElement;
    expect(screen.getByText("AI peer feedback sample rate")).toBeTruthy();
    expect(screen.getByText(/effective next-tick config/i)).toBeTruthy();

    fireEvent.change(aiPeerInput, { target: { value: "0.15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save quality controls" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/quality/config",
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/quality/config" && init?.method === "PATCH",
    );
    expect(JSON.parse(patchCall?.[1]?.body as string)).toEqual({
      hiveId: "hive-1",
      ownerFeedbackSampleRate: 0.08,
      aiPeerFeedbackSampleRate: 0.15,
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
