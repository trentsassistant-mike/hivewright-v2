// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NewHiveWizard from "../../src/app/(dashboard)/hives/new/page";

const navigationMocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigationMocks.push }),
}));

describe("NewHiveWizard", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    navigationMocks.push.mockClear();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/roles") && init?.method === "POST") {
        return jsonResponse({ data: { ok: true } });
      }

      if (url.includes("/api/roles")) {
        return jsonResponse({
          data: [
            {
              slug: "dev-agent",
              name: "Dev Agent",
              department: "eng",
              adapterType: "claude-code",
              recommendedModel: "anthropic/claude-sonnet-4-6",
            },
          ],
        });
      }

      if (url.includes("/api/connectors")) {
        return jsonResponse({
          data: [
            {
              slug: "ea-discord",
              name: "HiveWright EA (Discord)",
              category: "messaging",
              description: "Hosts this hive's Executive Assistant on Discord.",
              icon: null,
              authType: "api_key",
              setupFields: [
                { key: "applicationId", label: "Discord Application ID", type: "text", required: true },
                { key: "channelId", label: "Discord channel ID", type: "text", required: true },
                { key: "botToken", label: "Bot token", type: "password", required: true },
              ],
              operations: [{ slug: "self_test", label: "Test connection" }],
              requiresDispatcherRestart: true,
            },
            {
              slug: "gmail",
              name: "Gmail",
              category: "email",
              description: "Authorize Gmail for email operations.",
              icon: null,
              authType: "oauth2",
              setupFields: [],
              operations: [{ slug: "send_email", label: "Send email" }],
              requiresDispatcherRestart: false,
            },
          ],
        });
      }

      if (url.includes("/api/hives")) {
        return jsonResponse({ data: { id: "hive-123" } });
      }

      if (url.includes("/api/connector-installs")) {
        return jsonResponse({ data: { id: "install-123" } });
      }

      if (url.includes("/api/projects")) {
        return jsonResponse({ data: { id: "project-123" } });
      }

      if (url.includes("/api/goals")) {
        return jsonResponse({ data: { id: "goal-123" } });
      }

      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    localStorage.clear();
  });

  it("shows a plain-English welcome before setup and persists dismissal", async () => {
    const { unmount } = render(<NewHiveWizard />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Before you create your hive" })).toBeTruthy());
    for (const concept of ["HiveWright", "EA", "Agents", "Dispatcher", "Decisions", "Connectors", "Schedules", "Memory"]) {
      expect(screen.getByRole("heading", { name: concept })).toBeTruthy();
    }
    expect(screen.queryByLabelText("Hive name *")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue to setup" }));

    await waitFor(() => expect(screen.getByLabelText("Hive name *")).toBeTruthy());
    expect(localStorage.getItem("hivewright.setupWelcomeDismissed")).toBe("true");

    unmount();
    render(<NewHiveWizard />);

    await waitFor(() => expect(screen.getAllByRole("heading", { name: "Create a Hive" }).length).toBeGreaterThan(0));
    expect(screen.queryByRole("heading", { name: "Before you create your hive" })).toBeNull();
  });

  it("hides technical runtime controls by default and preserves them under Advanced", async () => {
    render(<NewHiveWizard />);

    await fillRequiredHiveFields();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Choose agent runtimes" })).toBeTruthy());
    expect(screen.getByText("Recommended")).toBeTruthy();
    expect(screen.queryByLabelText("Adapter")).toBeNull();
    expect(screen.queryByLabelText("Model")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Adapter|openai-codex\/gpt-5\.5|anthropic\/claude-sonnet-4-6|google\/gemini-2\.5-flash/);

    fireEvent.click(screen.getByRole("button", { name: "Advanced runtime details" }));

    const adapterSelect = screen.getByLabelText("Adapter") as HTMLSelectElement;
    fireEvent.change(adapterSelect, { target: { value: "codex" } });

    const modelSelect = screen.getByLabelText("Model") as HTMLSelectElement;
    const optionValues = Array.from(modelSelect.options).map((option) => option.value);

    expect(adapterSelect.value).toBe("codex");
    expect(optionValues).toContain("openai-codex/gpt-5.5");
    expect(optionValues).toContain("openai-codex/gpt-5.4");
    expect(optionValues).toContain("openai-codex/gpt-5.3-codex");
  });

  it("offers Gemini 3.1 Flash Live Preview in the advanced hive creation model picker", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/roles") && init?.method === "POST") {
        return jsonResponse({ data: { ok: true } });
      }

      if (url.includes("/api/roles")) {
        return jsonResponse({
          data: [
            {
              slug: "research-analyst",
              name: "Research Analyst",
              department: "research",
              adapterType: "gemini",
              recommendedModel: "google/gemini-2.5-flash",
            },
          ],
        });
      }

      if (url.includes("/api/connectors")) {
        return jsonResponse({ data: [] });
      }

      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<NewHiveWizard />);

    await fillRequiredHiveFields();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Choose agent runtimes" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Advanced runtime details" }));

    const modelSelect = screen.getByLabelText("Model") as HTMLSelectElement;
    const optionValues = Array.from(modelSelect.options).map((option) => option.value);

    expect(optionValues).not.toContain("google/gemini-3.1-flash-live-preview");
  });

  it("offers Mistral Large Latest in the advanced hive creation model picker", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/roles") && init?.method === "POST") {
        return jsonResponse({ data: { ok: true } });
      }

      if (url.includes("/api/roles")) {
        return jsonResponse({
          data: [
            {
              slug: "research-analyst",
              name: "Research Analyst",
              department: "research",
              adapterType: "mistral",
              recommendedModel: "mistral/mistral-large-latest",
            },
          ],
        });
      }

      if (url.includes("/api/connectors")) {
        return jsonResponse({ data: [] });
      }

      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<NewHiveWizard />);

    await fillRequiredHiveFields();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Choose agent runtimes" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Advanced runtime details" }));

    const modelSelect = screen.getByLabelText("Model") as HTMLSelectElement;
    const optionValues = Array.from(modelSelect.options).map((option) => option.value);

    expect(optionValues).toContain("mistral/mistral-large-latest");
    expect(optionValues).toContain("mistral/mistral-ocr-latest");
  });

  it("shows a dedicated EA setup step before generic services", async () => {
    render(<NewHiveWizard />);

    await fillRequiredHiveFields();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Choose agent runtimes" })).toBeTruthy());
    await advanceFromRuntimeToEa();
    expect(screen.getByText("Your EA can answer you in Discord and help you start work without opening HiveWright.")).toBeTruthy();
    expect(screen.getByLabelText(/Discord Application ID/)).toBeTruthy();
    expect(screen.getByLabelText(/Allowed Discord channel ID/)).toBeTruthy();
    expect(screen.getByLabelText(/Bot token/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "I'll do this later" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test after setup" })).toHaveProperty("disabled", true);
    expect(screen.queryByText(/credentials|adapter_config|\/api\//i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "I'll do this later" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Connect services" })).toBeTruthy());

    expect(screen.getByText("Authorize the services this hive can use. You can skip any connector and add it later.")).toBeTruthy();
    expect(screen.queryByText("HiveWright EA (Discord)")).toBeNull();
    expect(screen.getByText("Advanced manual setup")).toBeTruthy();
    expect(screen.getAllByText("You can finish this connection from Settings after the hive is created.").length).toBeGreaterThan(0);
    expect(screen.queryByText(/\/api\//i)).toBeNull();
    expect(screen.queryByText(/OpenClaw/i)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Credentials" })).toBeNull();
  });

  it("does not call removed setup endpoints while loading or moving through the wizard", async () => {
    render(<NewHiveWizard />);

    await fillRequiredHiveFields();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Choose agent runtimes" })).toBeTruthy());
    await advanceFromRuntimeToEa();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Connect services" })).toBeTruthy());

    const calledUrls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([input]) =>
      typeof input === "string" ? input : input.toString(),
    );
    expect(calledUrls.some((url) => url.includes("/api/ea"))).toBe(false);
    expect(calledUrls.some((url) => url.includes("/api/openclaw-detect"))).toBe(false);
  });

  it("hides the custom hive address by default and avoids owner-facing technical address copy", async () => {
    render(<NewHiveWizard />);

    await enterSetup();
    expect(screen.queryByText(/slug/i)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Custom hive address" }).closest("details")?.hasAttribute("open")).toBe(false);

    fireEvent.click(screen.getByText("Advanced"));

    expect(screen.getByRole("textbox", { name: "Custom hive address" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Custom hive address" }).closest("details")?.hasAttribute("open")).toBe(true);
    expect(screen.queryByText(/slug/i)).toBeNull();
  });

  it("submits a generated hive address from the hive name", async () => {
    render(<NewHiveWizard />);

    await fillRequiredHiveFields();
    fireEvent.change(screen.getByLabelText("First goal"), { target: { value: "Launch the refreshed onboarding" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Choose agent runtimes" })).toBeTruthy());
    await advanceFromRuntimeToEa();
    fireEvent.change(screen.getByLabelText(/Discord Application ID/), { target: { value: "app-123" } });
    fireEvent.change(screen.getByLabelText(/Allowed Discord channel ID/), { target: { value: "channel-123" } });
    fireEvent.change(screen.getByLabelText(/Bot token/), { target: { value: "bot-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this EA setup" }));
    expect(screen.queryByText("bot-token")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Connect services" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "+ Add Project" }));
    fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "HiveWright v2" } });
    expect(screen.queryByLabelText("Workspace path")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Workspace path|\/home\/|Local path validation/i);
    fireEvent.click(screen.getByRole("button", { name: "Advanced project details" }));
    fireEvent.change(screen.getByLabelText("Local folder override"), { target: { value: "operator-folder" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Review and launch" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create Hive" }));

    await waitFor(() => {
      const calledUrls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([input]) =>
        typeof input === "string" ? input : input.toString(),
      );
      expect(calledUrls).toContain("/api/hives/setup");
      expect(calledUrls).not.toContain("/api/hives");
      expect(calledUrls).not.toContain("/api/connector-installs");
      expect(calledUrls).not.toContain("/api/projects");
      expect(calledUrls).not.toContain("/api/goals");
      expect(calledUrls.some((url) => url.includes("/api/credentials"))).toBe(false);
    });

    const setupCall = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([input]) => input === "/api/hives/setup");
    expect(JSON.parse(setupCall?.[1]?.body as string)).toMatchObject({
      hive: {
        name: "Test Hive",
        slug: "test-hive",
      },
      connectors: [{
        connectorSlug: "ea-discord",
        fields: {
          applicationId: "app-123",
          channelId: "channel-123",
          botToken: "bot-token",
        },
      }],
      projects: [{ name: "HiveWright v2", slug: "hivewright-v2", workspacePath: "operator-folder" }],
      initialGoal: "Launch the refreshed onboarding",
      operatingPreferences: {
        maxConcurrentAgents: 3,
        proactiveWork: true,
        memorySearch: true,
        requestSorting: "balanced",
      },
    });
    expect(navigationMocks.push).toHaveBeenCalledWith("/setup/health");
  });

  it("asks plain-language operating preference questions and submits changed presets", async () => {
    render(<NewHiveWizard />);

    await fillRequiredHiveFields();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Choose agent runtimes" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Set working preferences" })).toBeTruthy());
    expect(screen.getByLabelText("How many agents may work at once?")).toHaveProperty("value", "3");
    expect(screen.getByText("Should HiveWright look for useful work on its own?")).toBeTruthy();
    expect(screen.getByText("Should HiveWright prepare memory search for this hive?")).toBeTruthy();
    expect(screen.getByLabelText("How should new requests be sorted?")).toBeTruthy();
    expect(screen.queryByText(/adapter_config|embeddings|classifier|cron|filesystem|model id/i)).toBeNull();

    fireEvent.change(screen.getByLabelText("How many agents may work at once?"), { target: { value: "5" } });
    fireEvent.click(screen.getByText("No, wait for me"));
    fireEvent.click(screen.getByText("Not yet"));
    fireEvent.change(screen.getByLabelText("How should new requests be sorted?"), { target: { value: "goals" } });

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Set up your Discord EA" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "I'll do this later" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Connect services" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Review and launch" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create Hive" }));

    await waitFor(() => {
      const setupCall = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([input]) => input === "/api/hives/setup");
      expect(setupCall).toBeTruthy();
      expect(JSON.parse(setupCall?.[1]?.body as string).operatingPreferences).toEqual({
        maxConcurrentAgents: 5,
        proactiveWork: false,
        memorySearch: false,
        requestSorting: "goals",
      });
    });
  });

  it("allows EA setup to be deferred without submitting an EA connector", async () => {
    render(<NewHiveWizard />);

    await fillRequiredHiveFields();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Choose agent runtimes" })).toBeTruthy());
    await advanceFromRuntimeToEa();
    fireEvent.click(screen.getByRole("button", { name: "I'll do this later" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Connect services" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Review and launch" })).toBeTruthy());
    expect(screen.getByText(/HiveWright EA \(Discord\): set aside for Settings after launch/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create Hive" }));

    await waitFor(() => {
      const setupCall = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([input]) => input === "/api/hives/setup");
      expect(setupCall).toBeTruthy();
      expect(JSON.parse(setupCall?.[1]?.body as string).connectors).toEqual([]);
    });
  });

  it("does not redirect to setup health when the hive setup endpoint reports failure", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/hives/setup")) {
        return new Response(
          JSON.stringify({ error: "A selected role could not be updated. Please review the runtime choices and try again." }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.includes("/api/roles") && init?.method === "POST") {
        return jsonResponse({ data: { ok: true } });
      }

      if (url.includes("/api/roles")) {
        return jsonResponse({
          data: [
            {
              slug: "dev-agent",
              name: "Dev Agent",
              department: "eng",
              adapterType: "claude-code",
              recommendedModel: "anthropic/claude-sonnet-4-6",
            },
          ],
        });
      }

      if (url.includes("/api/connectors")) {
        return jsonResponse({ data: [] });
      }

      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    render(<NewHiveWizard />);

    await fillRequiredHiveFields();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Choose agent runtimes" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Set working preferences" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Set up your Discord EA" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Connect services" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Review and launch" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create Hive" }));

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("A selected role could not be updated");
      expect(alert.textContent).toContain("Nothing has been marked complete");
    });
    expect(navigationMocks.push).not.toHaveBeenCalled();
    expect(localStorage.getItem("selectedHiveId")).toBeNull();
    const retryButton = screen.getByRole("button", { name: "Retry setup" });
    expect(retryButton).toBeTruthy();
    expect((retryButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps an advanced custom hive address stable when the name changes", async () => {
    render(<NewHiveWizard />);

    await fillRequiredHiveFields();
    fireEvent.click(screen.getByText("Advanced"));
    fireEvent.change(screen.getByRole("textbox", { name: "Custom hive address" }), { target: { value: "owner-picked-address" } });
    fireEvent.change(screen.getByLabelText("Hive name *"), { target: { value: "Renamed Hive" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Choose agent runtimes" })).toBeTruthy());
    await advanceFromRuntimeToEa();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Connect services" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Review and launch" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Create Hive" }));

    await waitFor(() => {
      const setupCall = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([input]) => input === "/api/hives/setup");
      expect(setupCall).toBeTruthy();
      expect(JSON.parse(setupCall?.[1]?.body as string).hive).toMatchObject({
        name: "Renamed Hive",
        slug: "owner-picked-address",
      });
    });
  });
});

async function fillRequiredHiveFields() {
  await enterSetup();
  fireEvent.change(screen.getByLabelText("Hive name *"), { target: { value: "Test Hive" } });
}

async function enterSetup() {
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue to setup" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Continue to setup" }));
  await waitFor(() => expect(screen.getByLabelText("Hive name *")).toBeTruthy());
}

async function advanceFromRuntimeToEa() {
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Set working preferences" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Set up your Discord EA" })).toBeTruthy());
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
