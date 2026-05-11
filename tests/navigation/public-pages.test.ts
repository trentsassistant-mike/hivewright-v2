import { describe, expect, it } from "vitest";
import { isPublicPage } from "../../src/navigation/public-pages";

describe("public page allowlist", () => {
  it("allows /landing only as a public preview page", () => {
    expect(isPublicPage("/landing")).toBe(true);
    expect(isPublicPage("/landing/")).toBe(true);
    expect(isPublicPage("/login")).toBe(true);
    expect(isPublicPage("/docs")).toBe(true);
  });

  it("keeps the dashboard root authenticated", () => {
    expect(isPublicPage("/")).toBe(false);
    expect(isPublicPage("/goals")).toBe(false);
  });
});
