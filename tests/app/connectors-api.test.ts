import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiAuth: vi.fn(),
}));

vi.mock("@/app/api/_lib/auth", () => ({
  requireApiAuth: mocks.requireApiAuth,
}));

const { GET } = await import("@/app/api/connectors/route");

describe("GET /api/connectors", () => {
  it("returns safe public connector capability metadata", async () => {
    mocks.requireApiAuth.mockResolvedValue(null);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    const discord = body.data.find((connector: { slug: string }) => connector.slug === "discord-webhook");
    expect(discord).toEqual(expect.objectContaining({
      slug: "discord-webhook",
      name: expect.any(String),
      category: expect.any(String),
      authType: "webhook",
      scopes: expect.arrayContaining([expect.objectContaining({ key: expect.any(String) })]),
    }));
    expect(discord.setupFields.find((field: { key: string }) => field.key === "webhookUrl")).toEqual(
      expect.objectContaining({ type: "password" }),
    );
    expect(discord.operations[0]).toEqual(expect.objectContaining({
      slug: expect.any(String),
      label: expect.any(String),
      governance: expect.objectContaining({
        effectType: expect.any(String),
        defaultDecision: expect.any(String),
        riskTier: expect.any(String),
        dryRunSupported: expect.any(Boolean),
      }),
      outputSummary: expect.any(String),
    }));
    expect(JSON.stringify(discord)).not.toContain("handler");
  });
});
