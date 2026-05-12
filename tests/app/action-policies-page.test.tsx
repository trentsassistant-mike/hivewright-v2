// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ActionPoliciesPage from "../../src/app/(dashboard)/setup/action-policies/page";

const hiveContextMock = vi.hoisted(() => ({
  value: {
    selected: { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" } as
      | { id: string; slug: string; name: string; type: string }
      | null,
    hives: [] as Array<{ id: string; slug: string; name: string; type: string }>,
    loading: false,
    selectHive: () => {},
  },
}));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => hiveContextMock.value,
}));

describe("ActionPoliciesPage", () => {
  beforeEach(() => {
    hiveContextMock.value = {
      selected: { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" },
      hives: [],
      loading: false,
      selectHive: () => {},
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads policies and connector operation governance for the selected hive", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      data: {
        policies: [policyFixture()],
        connectors: [connectorFixture()],
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<ActionPoliciesPage />);

    expect(screen.getByRole("heading", { name: "Action policies" })).toBeTruthy();
    expect(screen.getByText("Business-specific rules are configured per hive; HiveWright only enforces the policy.")).toBeTruthy();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/action-policies?hiveId=hive-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));

    expect(await screen.findByDisplayValue("Require approval for Discord send")).toBeTruthy();
    expect(screen.getAllByText("Discord webhook").length).toBeGreaterThan(0);
    expect(screen.getByText("Send message")).toBeTruthy();
    expect(screen.getAllByText(/notify · default require_approval/i).length).toBeGreaterThan(0);
  });

  it("adds, deletes, edits, and saves a generic policy array", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/action-policies?hiveId=hive-1")) {
        return jsonResponse({ data: { policies: [policyFixture()], connectors: [connectorFixture()] } });
      }
      if (url.includes("/api/action-policies") && init?.method === "PATCH") {
        return jsonResponse({ data: { policies: [] } });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ActionPoliciesPage />);
    await screen.findByDisplayValue("Require approval for Discord send");

    fireEvent.click(screen.getByRole("button", { name: "Add policy" }));
    expect(screen.getByDisplayValue("New action policy")).toBeTruthy();

    const firstPolicy = screen.getByDisplayValue("Require approval for Discord send").closest("article")!;
    fireEvent.change(within(firstPolicy).getByLabelText("Policy name"), {
      target: { value: "Block Discord sends" },
    });
    fireEvent.change(within(firstPolicy).getByLabelText("Decision"), {
      target: { value: "block" },
    });
    fireEvent.click(within(firstPolicy).getByRole("button", { name: "Delete policy" }));

    fireEvent.click(screen.getByRole("button", { name: "Save policies" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/action-policies",
      expect.objectContaining({
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: expect.stringContaining("New action policy"),
      }),
    ));
    const patchCall = fetchMock.mock.calls.find((call) => call[0] === "/api/action-policies")!;
    const body = JSON.parse(String(patchCall[1]?.body));
    expect(body.hiveId).toBe("hive-1");
    expect(body.policies).toHaveLength(1);
    expect(body.policies[0]).toMatchObject({
      name: "New action policy",
      decision: "require_approval",
      connectorSlug: null,
      operation: null,
      conditions: {},
    });
  });

  it("does not fetch when no hive is selected", () => {
    hiveContextMock.value = {
      selected: null,
      hives: [],
      loading: false,
      selectHive: () => {},
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<ActionPoliciesPage />);

    expect(screen.getByRole("heading", { name: "No hive selected" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function policyFixture() {
  return {
    id: "policy-1",
    hiveId: "hive-1",
    name: "Require approval for Discord send",
    enabled: true,
    connectorSlug: "discord-webhook",
    operation: "send-message",
    effectType: "notify",
    roleSlug: null,
    decision: "require_approval",
    priority: 25,
    reason: "Review outbound notifications",
    conditions: {},
  };
}

function connectorFixture() {
  return {
    slug: "discord-webhook",
    name: "Discord webhook",
    operations: [
      {
        slug: "send-message",
        label: "Send message",
        governance: {
          effectType: "notify",
          defaultDecision: "require_approval",
          summary: "Posts a message to a channel.",
        },
      },
    ],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
