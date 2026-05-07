import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_APP_ORIGIN,
  normalizeLocalAppOrigin,
  normalizeLocalAuthOriginEnv,
  normalizeLocalRedirectUrl,
  resolveLocalAppOrigin,
} from "@/auth/local-origin";

describe("resolveLocalAppOrigin", () => {
  it("defaults the local smoke path to the canonical loopback origin", () => {
    expect(resolveLocalAppOrigin(undefined)).toBe(DEFAULT_LOCAL_APP_ORIGIN);
  });

  it("normalizes localhost loopback input to the canonical origin", () => {
    expect(resolveLocalAppOrigin("http://localhost:3002")).toBe(
      DEFAULT_LOCAL_APP_ORIGIN,
    );
  });
});

describe("normalizeLocalAppOrigin", () => {
  it("preserves non-loopback origins", () => {
    expect(normalizeLocalAppOrigin("https://example.com:444")).toBe(
      "https://example.com:444",
    );
  });
});

describe("normalizeLocalAuthOriginEnv", () => {
  it("rewrites loopback auth env vars to the canonical local origin", () => {
    const env: NodeJS.ProcessEnv = {
      AUTH_URL: "http://localhost:3002",
      NEXTAUTH_URL: "http://localhost:3002",
      BASE_URL: "http://localhost:3002",
      NODE_ENV: "test",
    };

    expect(normalizeLocalAuthOriginEnv(env)).toBe(DEFAULT_LOCAL_APP_ORIGIN);
    expect(env.AUTH_URL).toBe(DEFAULT_LOCAL_APP_ORIGIN);
    expect(env.NEXTAUTH_URL).toBe(DEFAULT_LOCAL_APP_ORIGIN);
    expect(env.BASE_URL).toBe(DEFAULT_LOCAL_APP_ORIGIN);
  });

  it("leaves non-loopback env values untouched", () => {
    const env: NodeJS.ProcessEnv = {
      AUTH_URL: "https://example.com",
      NEXTAUTH_URL: "https://example.com",
      BASE_URL: "https://example.com",
      NODE_ENV: "test",
    };

    expect(normalizeLocalAuthOriginEnv(env)).toBe("https://example.com");
    expect(env.AUTH_URL).toBe("https://example.com");
    expect(env.NEXTAUTH_URL).toBe("https://example.com");
    expect(env.BASE_URL).toBe("https://example.com");
  });
});

describe("normalizeLocalRedirectUrl", () => {
  it("rewrites loopback redirect headers onto the canonical local origin", () => {
    expect(
      normalizeLocalRedirectUrl("http://localhost:3002/", DEFAULT_LOCAL_APP_ORIGIN),
    ).toBe("http://127.0.0.1:3002/");
  });

  it("preserves off-site redirects", () => {
    expect(
      normalizeLocalRedirectUrl("https://example.com/account", DEFAULT_LOCAL_APP_ORIGIN),
    ).toBe("https://example.com/account");
  });
});
