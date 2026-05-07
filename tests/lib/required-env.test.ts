import { describe, expect, it } from "vitest";
import { requireEnv } from "@/lib/required-env";

describe("requireEnv", () => {
  it("returns a non-empty env value", () => {
    expect(requireEnv("DATABASE_URL", { DATABASE_URL: "postgres://example" })).toBe(
      "postgres://example",
    );
  });

  it("throws a setup-focused error when a required value is missing", () => {
    expect(() => requireEnv("DATABASE_URL", {})).toThrow(
      "Missing required environment variable DATABASE_URL. Copy .env.example to .env and set DATABASE_URL.",
    );
  });

  it("treats blank strings as missing", () => {
    expect(() => requireEnv("INTERNAL_SERVICE_TOKEN", { INTERNAL_SERVICE_TOKEN: "   " })).toThrow(
      "Missing required environment variable INTERNAL_SERVICE_TOKEN.",
    );
  });
});
