// @vitest-environment jsdom

/**
 * WorkflowCapturePage — orchestration fetch tests
 *
 * Verifies that the page's three network-touching flows each:
 *   - POST /api/capture-sessions with consent=true, hiveId, no raw media  (criterion 7a)
 *   - PATCH /api/capture-sessions/[id] status=stopped, no raw media       (criterion 7b)
 *   - DELETE /api/capture-sessions/[id] on cancel+confirm, no raw media   (criterion 7c)
 *
 * Also verifies consent gating: no POST fires before the dialog is confirmed.
 *
 * These tests complement the isolated component tests (capture-ui.test.tsx)
 * and the API unit tests (capture-sessions.test.ts) by verifying that the
 * WorkflowCapturePage orchestration layer wires up fetch correctly.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// ---- router mock (must be before any dynamic import) ----
const routerPushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
  useParams: () => ({}),
}));

// ---- hive context mock ----
vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => ({
    selected: {
      id: "hive-test",
      name: "Test Hive",
      slug: "test-hive",
      type: "digital",
    },
  }),
}));

// ---- next/link stub ----
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

function makeMockStream() {
  const track = { stop: vi.fn(), onended: null as (() => void) | null };
  return { _track: track, getTracks: () => [track] };
}

class MockMediaRecorder {
  ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
  onerror: (() => void) | null = null;
  state = "recording";
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_: unknown) {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  start(_timeslice?: number) {}
  stop() {
    this.state = "inactive";
  }
}

// Raw media field names that must never appear in any request body
const RAW_FIELDS = [
  "video",
  "audio",
  "frames",
  "screenshots",
  "blob",
  "rawMedia",
  "videoData",
  "audioData",
  "binaryData",
];

function assertNoRawMedia(body: unknown) {
  if (typeof body !== "object" || body === null) return;
  for (const field of RAW_FIELDS) {
    expect(
      (body as Record<string, unknown>)[field],
      `raw media field "${field}" must not appear in request body`,
    ).toBeUndefined();
  }
}

// Typed alias for fetch mock.calls entries
type FetchCall = [url: string, init?: RequestInit];

// ---------------------------------------------------------------------------
// Per-test state
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  routerPushMock.mockReset();

  // Set up browser capture APIs in jsdom
  Object.defineProperty(navigator, "mediaDevices", {
    writable: true,
    configurable: true,
    value: {
      getDisplayMedia: vi.fn().mockResolvedValue(makeMockStream()),
    },
  });

  Object.defineProperty(window, "MediaRecorder", {
    writable: true,
    configurable: true,
    value: MockMediaRecorder,
  });

  // Default: confirm dialogs are dismissed (cancel tests override this)
  vi.spyOn(window, "confirm").mockReturnValue(false);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: render the page (dynamic import ensures mocks are hoisted first)
// ---------------------------------------------------------------------------

async function renderWorkflowCapturePage() {
  const { default: WorkflowCapturePage } = await import(
    "../../src/app/(dashboard)/settings/workflow-capture/page"
  );
  return render(<WorkflowCapturePage />);
}

// ---------------------------------------------------------------------------
// Helper: drive through the full consent flow and wait for recording phase.
// ---------------------------------------------------------------------------

async function reachRecordingPhase(sessionId: string) {
  globalThis.fetch = vi.fn(
    async (url: string, opts?: RequestInit): Promise<Response> => {
      if (url === "/api/capture-sessions" && opts?.method === "POST") {
        return new Response(
          JSON.stringify({ data: { id: sessionId, status: "recording" } }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: { id: sessionId, status: "stopped" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  ) as typeof globalThis.fetch;

  await renderWorkflowCapturePage();

  fireEvent.click(screen.getByRole("button", { name: /start browser capture/i }));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /start recording/i }));

  // Wait until the recording pill appears (phase === "recording")
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: /stop recording/i }),
    ).toBeTruthy(),
  );
}

// ---------------------------------------------------------------------------
// POST /api/capture-sessions — consent gating and payload
// ---------------------------------------------------------------------------

describe("WorkflowCapturePage — POST /api/capture-sessions", () => {
  it("does NOT call POST before consent dialog is confirmed", async () => {
    const fetchMock = vi.fn(async (url: string): Promise<Response> =>
      new Response(JSON.stringify({ url }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await renderWorkflowCapturePage();

    // Open dialog — no network call yet
    fireEvent.click(screen.getByRole("button", { name: /start browser capture/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT call POST when the consent dialog is cancelled", async () => {
    const fetchMock = vi.fn(async (url: string): Promise<Response> =>
      new Response(JSON.stringify({ url }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await renderWorkflowCapturePage();

    fireEvent.click(screen.getByRole("button", { name: /start browser capture/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs consent=true, status=recording, hiveId, and no raw media after confirm", async () => {
    const fetchMock = vi.fn(
      async (url: string, opts?: RequestInit): Promise<Response> => {
        if (url === "/api/capture-sessions" && opts?.method === "POST") {
          return new Response(
            JSON.stringify({ data: { id: "sess-001", status: "recording" } }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ url }), { status: 200 });
      },
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await renderWorkflowCapturePage();

    fireEvent.click(screen.getByRole("button", { name: /start browser capture/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls as unknown as FetchCall[];
      const postCall = calls.find(
        ([u, o]) => u === "/api/capture-sessions" && o?.method === "POST",
      );
      expect(postCall, "POST to /api/capture-sessions was not called").toBeTruthy();

      const body = JSON.parse(postCall![1]!.body as string) as Record<string, unknown>;
      expect(body.consent).toBe(true);
      expect(body.status).toBe("recording");
      expect(body.hiveId).toBe("hive-test");
      assertNoRawMedia(body);
    });
  });
});

// ---------------------------------------------------------------------------
// Stop action — PATCH with status=stopped, then navigate to review
// ---------------------------------------------------------------------------

describe("WorkflowCapturePage — Stop → PATCH /api/capture-sessions/[id]", () => {
  it("PATCHes status=stopped, no raw media, then navigates to review shell", async () => {
    const sessionId = "sess-stop-001";
    await reachRecordingPhase(sessionId);

    const stopFetch = vi.fn(
      async (url: string, opts?: RequestInit): Promise<Response> => {
        if (url === `/api/capture-sessions/${sessionId}` && opts?.method === "PATCH") {
          return new Response(
            JSON.stringify({ data: { id: sessionId, status: "stopped" } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ url }), { status: 200 });
      },
    );
    globalThis.fetch = stopFetch as typeof globalThis.fetch;

    fireEvent.click(screen.getByRole("button", { name: /stop recording/i }));

    await waitFor(() => {
      const calls = stopFetch.mock.calls as unknown as FetchCall[];
      const patchCall = calls.find(
        ([u, o]) =>
          u === `/api/capture-sessions/${sessionId}` && o?.method === "PATCH",
      );
      expect(patchCall, "PATCH to capture-sessions was not called on Stop").toBeTruthy();

      const body = JSON.parse(patchCall![1]!.body as string) as Record<string, unknown>;
      expect(body.status).toBe("stopped");
      assertNoRawMedia(body);
    });

    await waitFor(() => {
      expect(routerPushMock).toHaveBeenCalledWith(
        `/setup/workflow-capture/${sessionId}/review`,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Cancel action — DELETE /api/capture-sessions/[id], no raw media anywhere
// ---------------------------------------------------------------------------

describe("WorkflowCapturePage — Cancel → DELETE /api/capture-sessions/[id]", () => {
  it("DELETEs the session on confirm; no raw media in any request", async () => {
    const sessionId = "sess-cancel-001";

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await reachRecordingPhase(sessionId);

    const cancelFetch = vi.fn(
      async (url: string, opts?: RequestInit): Promise<Response> => {
        if (url === `/api/capture-sessions/${sessionId}` && opts?.method === "DELETE") {
          return new Response(
            JSON.stringify({ data: { id: sessionId, purged: true } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ url }), { status: 200 });
      },
    );
    globalThis.fetch = cancelFetch as typeof globalThis.fetch;

    fireEvent.click(
      screen.getByRole("button", {
        name: /cancel recording and discard all captured content/i,
      }),
    );

    await waitFor(() => {
      const calls = cancelFetch.mock.calls as unknown as FetchCall[];
      const deleteCall = calls.find(
        ([u, o]) =>
          u === `/api/capture-sessions/${sessionId}` && o?.method === "DELETE",
      );
      expect(deleteCall, "DELETE to capture-sessions was not called on Cancel").toBeTruthy();
    });

    // Confirm no raw media in any call body
    const allCalls = cancelFetch.mock.calls as unknown as FetchCall[];
    for (const [, opts] of allCalls) {
      if (opts?.body) {
        assertNoRawMedia(JSON.parse(opts.body as string) as Record<string, unknown>);
      }
    }
  });

  it("does NOT delete when the user dismisses the confirm dialog", async () => {
    const sessionId = "sess-cancel-dismiss";

    // window.confirm returns false (set in beforeEach)
    await reachRecordingPhase(sessionId);

    const cancelFetch = vi.fn(
      async (url: string, opts?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ url, method: opts?.method }), { status: 200 }),
    );
    globalThis.fetch = cancelFetch as typeof globalThis.fetch;

    fireEvent.click(
      screen.getByRole("button", {
        name: /cancel recording and discard all captured content/i,
      }),
    );

    await new Promise((r) => setTimeout(r, 30));

    const calls = cancelFetch.mock.calls as unknown as FetchCall[];
    const deleteCall = calls.find(
      ([u, o]) =>
        u === `/api/capture-sessions/${sessionId}` && o?.method === "DELETE",
    );
    expect(deleteCall).toBeUndefined();
  });
});
