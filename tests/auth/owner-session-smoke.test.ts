import { describe, expect, it, vi } from "vitest";
import {
  OwnerSessionSmokeError,
  preflightOwnerSessionLocalSmoke,
  runOwnerSessionLocalSmoke,
  runOwnerSessionSmokeChecks,
  serializeOwnerSessionSmokeError,
  type OwnerSessionSmokeConfig,
} from "@/auth/owner-session-smoke";

function makeConfig(
  overrides: Partial<OwnerSessionSmokeConfig> = {},
): OwnerSessionSmokeConfig {
  return {
    baseUrl: "http://127.0.0.1:3002",
    databaseUrl: "postgresql://hivewright:hivewright@localhost:5432/hivewright",
    ownerEmail: "owner-qa@hivewright.local",
    ownerPassword: "owner-session-pass",
    ownerDisplayName: "Local QA Owner",
    resetEnabled: true,
    ...overrides,
  };
}

describe("preflightOwnerSessionLocalSmoke", () => {
  it("fails fast with env-missing when OWNER_PASSWORD is absent", async () => {
    await expect(
      preflightOwnerSessionLocalSmoke(makeConfig({ ownerPassword: null })),
    ).rejects.toMatchObject({
      category: "env-missing",
      message: "OWNER_PASSWORD is required.",
    });
  });

  it("fails fast with env-missing when reset gate is absent", async () => {
    await expect(
      preflightOwnerSessionLocalSmoke(makeConfig({ resetEnabled: false })),
    ).rejects.toMatchObject({
      category: "env-missing",
      message: "ALLOW_LOCAL_OWNER_SESSION_RESET=1 is required for local owner-session smoke.",
    });
  });

  it("classifies unreachable app setup-state as app-unreachable", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(
      preflightOwnerSessionLocalSmoke(makeConfig(), { fetchImpl }),
    ).rejects.toMatchObject({
      category: "app-unreachable",
    });
  });

  it("classifies needsSetup=true as setup-reset-failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: { needsSetup: true, userCount: 0 } }), {
        status: 200,
      }),
    );

    await expect(
      preflightOwnerSessionLocalSmoke(makeConfig(), { fetchImpl }),
    ).rejects.toMatchObject({
      category: "setup-reset-failure",
    });
  });
});

describe("runOwnerSessionSmokeChecks", () => {
  it("classifies failed auth assertions as auth-failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const headers =
        init?.headers && typeof init.headers === "object"
          ? (init.headers as Record<string, string>)
          : {};
      const hasCookie = typeof headers.cookie === "string" && headers.cookie.length > 0;

      if (url.endsWith("/api/auth/csrf")) {
        return new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
          status: 200,
          headers: { "set-cookie": "csrf-token=csrf-token; Path=/; HttpOnly" },
        });
      }

      if (url.endsWith("/api/auth/callback/credentials")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: "http://127.0.0.1:3002/",
            "set-cookie": "authjs.session-token=session-1; Path=/; HttpOnly",
          },
        });
      }

      if (url.endsWith("/api/dashboard/summary?hiveId=hive-123")) {
        return hasCookie
          ? new Response(JSON.stringify({ error: "still unauthorized" }), { status: 401 })
          : new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }

      if (url.endsWith("/")) {
        return hasCookie
          ? new Response(null, { status: 307, headers: { location: "/login" } })
          : new Response(null, { status: 307, headers: { location: "/login" } });
      }

      throw new Error(`unexpected url ${url}`);
    });

    await expect(
      runOwnerSessionSmokeChecks(makeConfig(), {
        fetchImpl,
        ensureSmokeHiveImpl: async () => "hive-123",
      }),
    ).rejects.toMatchObject({
      category: "auth-failure",
    });
  });

  it("fails when the credentials callback redirects to a non-canonical loopback host", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const headers =
        init?.headers && typeof init.headers === "object"
          ? (init.headers as Record<string, string>)
          : {};
      const hasCookie = typeof headers.cookie === "string" && headers.cookie.length > 0;

      if (url.endsWith("/api/auth/csrf")) {
        return new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
          status: 200,
          headers: { "set-cookie": "csrf-token=csrf-token; Path=/; HttpOnly" },
        });
      }

      if (url.endsWith("/api/auth/callback/credentials")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: "http://localhost:3002/",
            "set-cookie": "authjs.session-token=session-1; Path=/; HttpOnly",
          },
        });
      }

      if (url.endsWith("/api/dashboard/summary?hiveId=hive-123")) {
        return hasCookie
          ? new Response(JSON.stringify({ ok: true }), { status: 200 })
          : new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
      }

      if (url.endsWith("/")) {
        return hasCookie
          ? new Response("<html>ok</html>", { status: 200 })
          : new Response(null, { status: 307, headers: { location: "/login" } });
      }

      throw new Error(`unexpected url ${url}`);
    });

    let thrown: unknown;
    try {
      await runOwnerSessionSmokeChecks(makeConfig(), {
        fetchImpl,
        ensureSmokeHiveImpl: async () => "hive-123",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(OwnerSessionSmokeError);
    expect(thrown).toMatchObject({
      category: "auth-failure",
    });
    expect((thrown as OwnerSessionSmokeError).details?.summary).toMatchObject({
      originConsistency: {
        noHostDrift: false,
        loginRedirect: {
          value: "http://localhost:3002/",
          emittedOrigin: "http://localhost:3002",
          normalizedOrigin: "http://127.0.0.1:3002",
          hostDrift: true,
        },
      },
    });
  });
});

describe("runOwnerSessionLocalSmoke", () => {
  it("returns the canonical command result on success", async () => {
    const result = await runOwnerSessionLocalSmoke(makeConfig(), {
      preflightImpl: async () => ({
        setupState: {
          needsSetup: false,
          userCount: 3,
        },
      }),
      resetImpl: async () => ({
        mode: "updated",
        user: {
          id: "user-1",
          email: "owner-qa@hivewright.local",
          displayName: "Local QA Owner",
          isSystemOwner: true,
        },
      }),
      smokeImpl: async () => ({
        ok: true,
        baseUrl: "http://127.0.0.1:3002",
        ownerEmail: "owner-qa@hivewright.local",
        hiveId: "hive-1",
        originConsistency: {
          canonicalOrigin: "http://127.0.0.1:3002",
          noHostDrift: true,
          unauthenticatedPageRedirect: {
            value: "http://127.0.0.1:3002/login",
            emittedOrigin: "http://127.0.0.1:3002",
            normalizedOrigin: "http://127.0.0.1:3002",
            hostDrift: false,
          },
          loginRedirect: {
            value: "http://127.0.0.1:3002/",
            emittedOrigin: "http://127.0.0.1:3002",
            normalizedOrigin: "http://127.0.0.1:3002",
            hostDrift: false,
          },
          authenticatedPageRedirect: {
            value: null,
            emittedOrigin: null,
            normalizedOrigin: null,
            hostDrift: false,
          },
        },
        checks: {
          unauthenticatedPage: { path: "/", status: 307, location: "/login" },
          unauthenticatedApi: {
            path: "/api/dashboard/summary?hiveId=hive-1",
            status: 401,
            body: "{\"error\":\"Unauthorized\"}",
          },
          login: { status: 302, location: "http://127.0.0.1:3002/" },
          authenticatedPage: { path: "/", status: 200, location: null },
          authenticatedApi: {
            path: "/api/dashboard/summary?hiveId=hive-1",
            status: 200,
            body: "{\"ok\":true}",
          },
        },
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      command: "npm run auth:owner-smoke:local",
      preflight: { setupState: { needsSetup: false, userCount: 3 } },
      reset: { mode: "updated" },
      smoke: { ok: true, hiveId: "hive-1" },
    });
  });

  it("serializes unexpected errors into setup-reset-failure", () => {
    expect(serializeOwnerSessionSmokeError(new Error("boom"))).toEqual({
      ok: false,
      category: "setup-reset-failure",
      error: "boom",
    });
  });
});
