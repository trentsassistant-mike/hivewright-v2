// @vitest-environment jsdom

/**
 * Component tests for the browser capture UI:
 *   - CaptureConsentDialog: consent gating before any getDisplayMedia call
 *   - CaptureRecordingPill: recording indicator rendering and button interactions
 *   - CaptureReviewPage: review shell renders metadata, no-raw-storage notice, actions
 *
 * These tests verify the UI-layer criteria that cannot be covered by API unit tests:
 *   - Consent checkbox must be checked before onConfirm fires (consent gating)
 *   - Recording pill shows elapsed time and correct action buttons
 *   - Review shell loads session metadata from GET /api/capture-sessions/[id] and
 *     clearly communicates that no raw media was stored and no automation is active
 */

import React from "react";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import { CaptureConsentDialog } from "../../src/components/capture-consent-dialog";
import { CaptureRecordingPill } from "../../src/components/capture-recording-pill";

// ---- Next.js navigation mocks ----
vi.mock("next/navigation", () => ({
  useParams: () => ({ captureId: "session-abc" }),
  useRouter: () => ({ push: vi.fn() }),
}));

// ---- Hive context mock ----
vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => ({
    selected: {
      id: "hive-111",
      name: "Test Hive",
      slug: "test-hive",
      type: "digital",
    },
  }),
}));

// ---- next/link mock ----
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
    React.createElement("a", { href, className }, children),
}));

// -------------------------------------------------------------------------
// CaptureConsentDialog
// -------------------------------------------------------------------------
describe("<CaptureConsentDialog>", () => {
  it("renders nothing when open=false", () => {
    const { container } = render(
      <CaptureConsentDialog open={false} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the dialog when open=true", () => {
    render(
      <CaptureConsentDialog open={true} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Start browser capture?")).toBeTruthy();
  });

  it("disables Start Recording until the consent checkbox is checked", () => {
    render(
      <CaptureConsentDialog open={true} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    const startBtn = screen.getByRole("button", { name: /start recording/i });
    expect((startBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables Start Recording after the checkbox is checked", () => {
    render(
      <CaptureConsentDialog open={true} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    const startBtn = screen.getByRole("button", { name: /start recording/i });
    expect((startBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("calls onConfirm when checkbox is checked and Start Recording is clicked", () => {
    const onConfirm = vi.fn();
    render(
      <CaptureConsentDialog open={true} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /start recording/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel and does NOT call onConfirm when Cancel is clicked", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <CaptureConsentDialog open={true} onConfirm={onConfirm} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("lists the key consent disclosures", () => {
    render(
      <CaptureConsentDialog open={true} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    // No raw upload disclosure
    expect(screen.getByText(/no video.*audio.*raw media.*uploaded/i)).toBeTruthy();
    // No automation disclosure
    expect(screen.getByText(/no automation activates/i)).toBeTruthy();
  });
});

// -------------------------------------------------------------------------
// CaptureRecordingPill
// -------------------------------------------------------------------------
describe("<CaptureRecordingPill>", () => {
  it("renders the elapsed duration as MM:SS", () => {
    render(
      <CaptureRecordingPill durationSecs={75} onStop={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText("01:15")).toBeTruthy();
  });

  it("renders Stop and Cancel buttons enabled by default", () => {
    render(
      <CaptureRecordingPill durationSecs={0} onStop={vi.fn()} onCancel={vi.fn()} />,
    );
    const stopBtn = screen.getByRole("button", { name: /stop recording/i });
    const cancelBtn = screen.getByRole("button", { name: /cancel recording/i });
    expect((stopBtn as HTMLButtonElement).disabled).toBe(false);
    expect((cancelBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables buttons and shows Stopping… when stopping=true", () => {
    render(
      <CaptureRecordingPill durationSecs={10} onStop={vi.fn()} onCancel={vi.fn()} stopping={true} />,
    );
    expect(screen.getByText("Stopping…")).toBeTruthy();
    const stopBtn = screen.getByRole("button", { name: /stop recording/i });
    expect((stopBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables buttons and shows Cancelling… when cancelling=true", () => {
    render(
      <CaptureRecordingPill durationSecs={10} onStop={vi.fn()} onCancel={vi.fn()} cancelling={true} />,
    );
    expect(screen.getByText("Cancelling…")).toBeTruthy();
    const cancelBtn = screen.getByRole("button", { name: /cancel recording/i });
    expect((cancelBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it("calls onStop when Stop is clicked", () => {
    const onStop = vi.fn();
    render(
      <CaptureRecordingPill durationSecs={5} onStop={onStop} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /stop recording/i }));
    expect(onStop).toHaveBeenCalledOnce();
  });

  it("calls onCancel when Cancel is clicked", () => {
    const onCancel = vi.fn();
    render(
      <CaptureRecordingPill durationSecs={5} onStop={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel recording/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

// -------------------------------------------------------------------------
// CaptureReviewPage (review shell)
// -------------------------------------------------------------------------
describe("CaptureReviewPage (review shell)", () => {
  let originalFetch: typeof globalThis.fetch;

  const stoppedSession = {
    id: "session-abc",
    hiveId: "hive-111",
    ownerEmail: "test@local",
    status: "stopped",
    consentedAt: "2026-05-01T01:00:00Z",
    startedAt: "2026-05-01T01:00:00Z",
    stoppedAt: "2026-05-01T01:01:30Z",
    cancelledAt: null,
    captureScope: { type: "browser_tab" },
    metadata: {
      title: "Invoice follow up",
      observedSteps: ["Open CRM", "Find overdue invoice"],
      inferredInputs: ["Customer account", "Invoice ID"],
      decisionNotes: ["Escalate if account is marked high risk"],
    },
    evidenceSummary: null,
    redactedSummary: null,
    createdAt: "2026-05-01T01:00:00Z",
    updatedAt: "2026-05-01T01:01:30Z",
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function renderReviewPage() {
    const moduleUrl = pathToFileURL(resolve(
      process.cwd(),
      "src/app/(dashboard)/settings/workflow-capture/[captureId]/review/page.tsx",
    )).href;
    const { default: CaptureReviewPage } = await import(/* @vite-ignore */ moduleUrl);
    return render(<CaptureReviewPage />);
  }

  function installReviewFetch(overrides?: {
    draftGet?: Response;
    draftPost?: Response;
    draftDelete?: Response;
    session?: Response;
  }) {
    const sessionResponse = overrides?.session ?? new Response(
      JSON.stringify({ data: stoppedSession }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url === "/api/capture-sessions/session-abc/draft" && (!opts || opts.method === undefined)) {
        return overrides?.draftGet ?? new Response(
          JSON.stringify({
            data: {
              preview: {
                title: "Invoice follow up",
                observedSteps: ["Open CRM", "Find overdue invoice"],
                inferredInputs: ["Customer account", "Invoice ID"],
                decisionNotes: ["Escalate if account is marked high risk"],
                confidence: {
                  level: "medium",
                  score: 0.65,
                  rationale: "The capture includes enough structured metadata for a reviewable first draft.",
                },
                sensitiveDataWarnings: ["Check customer data before approval"],
                redactionNotes: ["Customer names redacted"],
                suggestedSkillContent: "# Invoice follow up\n\n## Observed steps\n\n- Open CRM",
                source: {
                  captureSessionId: "session-abc",
                  fieldsUsed: ["metadata", "evidenceSummary", "redactedSummary", "captureScope"],
                  rawMediaAccepted: false,
                },
              },
              previewStatus: "generated",
              approvedDraftId: null,
              approvedDraftStatus: null,
              rawMediaAccepted: false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/capture-sessions/session-abc/draft" && opts?.method === "POST") {
        return overrides?.draftPost ?? new Response(
          JSON.stringify({
            data: {
              draft: {
                id: "draft-123",
                status: "pending",
                slug: "capture-session-abc",
                internalSourceRef: "capture-session:session-abc",
                provenanceUrl: "/setup/workflow-capture/session-abc/review",
                securityReviewStatus: "not_required",
                qaReviewStatus: "pending",
                publishedAt: null,
              },
              created: true,
              duplicate: false,
              message: "Inactive pending draft created from capture session metadata.",
              rawMediaAccepted: false,
            },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/api/capture-sessions/session-abc/draft" && opts?.method === "DELETE") {
        return overrides?.draftDelete ?? new Response(
          JSON.stringify({
            data: {
              previewStatus: "rejected",
              rejected: true,
              rawMediaAccepted: false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return sessionResponse.clone();
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    return fetchMock;
  }

  it("shows a loading state while the session is being fetched", async () => {
    let resolveLoad!: (v: Response) => void;
    globalThis.fetch = vi.fn(
      () => new Promise<Response>((res) => { resolveLoad = res; }),
    ) as unknown as typeof globalThis.fetch;

    await renderReviewPage();
    expect(screen.getByText(/loading session/i)).toBeTruthy();

    // Resolve to avoid act() warnings
    resolveLoad(new Response(JSON.stringify({ data: stoppedSession }), { status: 200 }));
  });

  it("renders session metadata after fetch resolves", async () => {
    installReviewFetch();

    await renderReviewPage();

    await waitFor(() => expect(screen.getByText("session-abc")).toBeTruthy());
    expect(screen.getByText("stopped")).toBeTruthy();
  });

  it("shows the inactive draft notice communicating no automation and no raw storage", async () => {
    installReviewFetch();

    await renderReviewPage();

    await waitFor(() => expect(screen.getByText(/draft preview/i)).toBeTruthy());
    expect(screen.getByText(/no workflow is published.*approved.*installed.*activated/i)).toBeTruthy();
    expect(screen.getByText(/no raw video.*audio.*screenshots.*frames/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /approve draft/i })).toBeTruthy();
    expect(screen.getByText(/ai step inference is still pending future work/i)).toBeTruthy();
    expect(screen.getAllByText(/observed steps/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/customer names redacted/i)).toBeTruthy();
  });

  it("renders a Back link and a Delete session button", async () => {
    installReviewFetch();

    await renderReviewPage();

    await waitFor(() => expect(screen.getByText(/delete session/i)).toBeTruthy());
    const backLink = screen.getByRole("link", { name: /back/i });
    expect(backLink.getAttribute("href")).toBe("/setup/workflow-capture");
  });

  it("approves an edited draft from the review shell and shows its identifier", async () => {
    const fetchMock = installReviewFetch({
      draftPost: new Response(
        JSON.stringify({
          data: {
            draft: {
              id: "draft-123",
              status: "pending",
              slug: "capture-session-abc",
              internalSourceRef: "capture-session:session-abc",
              qaReviewStatus: "pending",
            },
            created: true,
            duplicate: false,
            message: "Inactive pending draft created from capture session metadata.",
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    });

    await renderReviewPage();

    await waitFor(() => expect(screen.getByText("session-abc")).toBeTruthy());
    const editor = await screen.findByLabelText(/skill\.md draft body/i);
    fireEvent.change(editor, {
      target: { value: "# Edited draft\n\n## Observed steps\n\n- Owner reviewed step" },
    });
    fireEvent.click(screen.getByRole("button", { name: /approve draft/i }));

    await waitFor(() => expect(screen.getByText(/draft-123/i)).toBeTruthy());
    expect(screen.getByText(/status: pending/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /inactive draft created/i })).toBeTruthy();
    const postCall = fetchMock.mock.calls.find(
      ([url, opts]) => url === "/api/capture-sessions/session-abc/draft" &&
        opts?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    expect(String(postCall?.[1]?.body)).toContain("Approved from capture review shell");
    expect(String(postCall?.[1]?.body)).toContain("Owner reviewed step");
  });

  it("shows duplicate draft status without enabling repeated creation", async () => {
    installReviewFetch({
      draftPost: new Response(
        JSON.stringify({
          data: {
            draft: {
              id: "draft-existing",
              status: "pending",
              slug: "capture-session-abc",
              internalSourceRef: "capture-session:session-abc",
              qaReviewStatus: "pending",
            },
            created: false,
            duplicate: true,
            message: "A draft already exists for this capture session.",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    });

    await renderReviewPage();

    await waitFor(() => expect(screen.getByText("session-abc")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /approve draft/i }));
    await waitFor(() =>
      expect(screen.getByText(/existing inactive pending draft found/i)).toBeTruthy(),
    );
    const draftButton = screen.getByRole("button", { name: /inactive draft created/i });
    expect((draftButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders draft creation errors separately from session load errors", async () => {
    installReviewFetch({
      draftPost: new Response(JSON.stringify({ error: "pending skill drafts cap reached" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    });

    await renderReviewPage();

    await waitFor(() => expect(screen.getByText("session-abc")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /approve draft/i }));

    await waitFor(() => expect(screen.getByText(/pending skill drafts cap reached/i)).toBeTruthy());
  });

  it("lets the owner reject the generated draft preview without approving it", async () => {
    const fetchMock = installReviewFetch();

    await renderReviewPage();

    await waitFor(() => expect(screen.getByText("session-abc")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /reject draft/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /draft rejected/i })).toBeTruthy());
    const deleteCall = fetchMock.mock.calls.find(
      ([url, opts]) => url === "/api/capture-sessions/session-abc/draft" &&
        opts?.method === "DELETE",
    );
    expect(deleteCall).toBeTruthy();
    const postCall = fetchMock.mock.calls.find(
      ([url, opts]) => url === "/api/capture-sessions/session-abc/draft" &&
        opts?.method === "POST",
    );
    expect(postCall).toBeFalsy();
  });

  it("renders an error message when the fetch fails", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "Session not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof globalThis.fetch;

    await renderReviewPage();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText(/session not found/i)).toBeTruthy();
  });
});
