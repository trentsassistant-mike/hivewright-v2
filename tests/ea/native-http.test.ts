import { describe, it, expect, vi, afterEach } from "vitest";
import { postEaCreateRequest } from "@/ea/native/http";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("native EA create HTTP helper", () => {
  it("attaches a UUID v4 Idempotency-Key to work intake and break-glass direct creates", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: { id: "ok" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await postEaCreateRequest({
      apiBaseUrl: "http://localhost:3002",
      route: "/api/work",
      token: "token",
      body: { hiveId: "h", input: "owner work" },
    });
    await postEaCreateRequest({
      apiBaseUrl: "http://localhost:3002",
      route: "/api/tasks",
      token: "token",
      body: { hiveId: "h", title: "t", bypassReason: "break glass" },
    });

    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("Idempotency-Key")).toMatch(UUID_V4);
    }
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Idempotency-Key"))
      .not.toBe(new Headers(fetchMock.mock.calls[1][1]?.headers).get("Idempotency-Key"));
  });

  it("reuses the same UUID when retrying one create internally", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "temporary" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { id: "ok" } }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await postEaCreateRequest({
      apiBaseUrl: "http://localhost:3002",
      route: "/api/goals",
      token: "token",
      body: { hiveId: "h", title: "g" },
      maxAttempts: 2,
    });

    expect(response.status).toBe(201);
    const firstKey = new Headers(fetchMock.mock.calls[0][1]?.headers).get("Idempotency-Key");
    const secondKey = new Headers(fetchMock.mock.calls[1][1]?.headers).get("Idempotency-Key");
    expect(firstKey).toMatch(UUID_V4);
    expect(secondKey).toBe(firstKey);
  });
});
