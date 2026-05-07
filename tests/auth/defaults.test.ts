import { describe, expect, it } from "vitest";
import {
  resolveAuthSecret,
  resolveBootstrapDashboardPassword,
} from "@/auth/defaults";

describe("resolveAuthSecret", () => {
  it("uses the development auth secret only in NODE_ENV=development", () => {
    expect(resolveAuthSecret({ NODE_ENV: "development" })).toBe(
      "dev-secret-change-in-production",
    );
  });

  it("fails outside development when no auth secret is configured", () => {
    expect(() => resolveAuthSecret({ NODE_ENV: "production" })).toThrow(
      /AUTH_SECRET or ENCRYPTION_KEY/,
    );
  });

  it("fails outside development when the development secret is configured", () => {
    expect(() =>
      resolveAuthSecret({
        NODE_ENV: "production",
        AUTH_SECRET: "dev-secret-change-in-production",
      }),
    ).toThrow(/Unsafe development AUTH_SECRET/);
  });

  it("accepts an explicit non-development secret", () => {
    expect(
      resolveAuthSecret({
        NODE_ENV: "production",
        AUTH_SECRET: "configured-auth-secret",
      }),
    ).toBe("configured-auth-secret");
  });

  it("falls back to ENCRYPTION_KEY when AUTH_SECRET is absent", () => {
    expect(
      resolveAuthSecret({
        NODE_ENV: "production",
        ENCRYPTION_KEY: "configured-encryption-key",
      }),
    ).toBe("configured-encryption-key");
  });
});

describe("resolveBootstrapDashboardPassword", () => {
  it("uses the known bootstrap password only in NODE_ENV=development", () => {
    expect(resolveBootstrapDashboardPassword({ NODE_ENV: "development" })).toBe(
      "hivewright",
    );
  });

  it("fails outside development when DASHBOARD_PASSWORD is missing", () => {
    expect(() =>
      resolveBootstrapDashboardPassword({ NODE_ENV: "production" }),
    ).toThrow(/DASHBOARD_PASSWORD/);
  });

  it("accepts an explicit DASHBOARD_PASSWORD outside development", () => {
    expect(
      resolveBootstrapDashboardPassword({
        NODE_ENV: "production",
        DASHBOARD_PASSWORD: "configured-dashboard-password",
      }),
    ).toBe("configured-dashboard-password");
  });
});
