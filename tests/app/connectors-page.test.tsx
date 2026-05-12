// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectorsPage from "../../src/app/(dashboard)/setup/connectors/page";

const hiveContextMock = vi.hoisted(() => ({
  value: {
    selected: { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" } as
      | { id: string; slug: string; name: string; type: string }
      | null,
    hives: [],
    loading: false,
    selectHive: () => {},
  },
}));

vi.mock("@/components/hive-context", () => ({
  useHiveContext: () => hiveContextMock.value,
}));

describe("ConnectorsPage", () => {
  beforeEach(() => {
    hiveContextMock.value.selected = { id: "hive-1", slug: "hive-one", name: "Hive One", type: "digital" };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows installed health, capability risk, scopes, policy link, and recent actions", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/connectors") {
        return jsonResponse({ data: [connectorFixture()] });
      }
      if (url === "/api/connector-installs?hiveId=hive-1") {
        return jsonResponse({ data: [installFixture()] });
      }
      if (url === "/api/connector-installs/install-1/actions") {
        return jsonResponse({ data: [actionFixture()] });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ConnectorsPage />);

    expect(await screen.findByRole("heading", { name: "Connectors" })).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/connector-installs/install-1/actions"));

    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText(/last tested/i)).toBeTruthy();
    expect(screen.getAllByText("send").length).toBeGreaterThan(0);
    expect(screen.getAllByText((_content, element) => element?.textContent?.includes("notify") ?? false).length).toBeGreaterThan(0);
    expect(screen.getAllByText((_content, element) => element?.textContent?.includes("require_approval") ?? false).length).toBeGreaterThan(0);
    expect(screen.getByText("discord-webhook:send_message")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Action policies" }).getAttribute("href")).toBe("/setup/action-policies");
    expect(screen.getAllByText((_content, element) => element?.textContent?.includes("send_message · succeeded") ?? false).length).toBeGreaterThan(0);
  });
});

function connectorFixture() {
  return {
    slug: "discord-webhook",
    name: "Discord webhook",
    category: "messaging",
    description: "Post messages to Discord",
    icon: null,
    authType: "webhook",
    setupFields: [],
    scopes: [
      { key: "discord-webhook:test_connection", label: "Test connection", kind: "read", required: true },
      { key: "discord-webhook:send_message", label: "Send message", kind: "send", required: false },
    ],
    operations: [
      {
        slug: "send_message",
        label: "Send message",
        governance: { effectType: "notify", defaultDecision: "require_approval", riskTier: "medium" },
        outputSummary: "Posts a message.",
      },
    ],
  };
}

function installFixture() {
  return {
    id: "install-1",
    hiveId: "hive-1",
    connectorSlug: "discord-webhook",
    displayName: "Discord",
    config: {},
    credentialId: "cred-1",
    status: "active",
    lastTestedAt: "2026-05-12T01:00:00.000Z",
    lastError: null,
    createdAt: "2026-05-12T00:00:00.000Z",
    successes7d: 3,
    errors7d: 1,
    grantedScopes: ["discord-webhook:test_connection", "discord-webhook:send_message"],
  };
}

function actionFixture() {
  return {
    id: "action-1",
    connector: "discord-webhook",
    operation: "send_message",
    state: "succeeded",
    roleSlug: "ea",
    policyId: "policy-1",
    policyReason: "matched action policy policy-1",
    createdAt: "2026-05-12T02:00:00.000Z",
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
