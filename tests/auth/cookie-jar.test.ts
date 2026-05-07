import { describe, expect, it } from "vitest";
import {
  cookieHeader,
  splitSetCookieHeader,
  storeResponseCookies,
} from "@/auth/cookie-jar";

describe("splitSetCookieHeader", () => {
  it("keeps expires dates intact when multiple cookies are folded into one header", () => {
    const header =
      "csrf-token=abc; Path=/; HttpOnly; Expires=Wed, 01 Jan 2030 00:00:00 GMT, " +
      "authjs.session-token=xyz; Path=/; HttpOnly; SameSite=Lax";

    expect(splitSetCookieHeader(header)).toEqual([
      "csrf-token=abc; Path=/; HttpOnly; Expires=Wed, 01 Jan 2030 00:00:00 GMT",
      "authjs.session-token=xyz; Path=/; HttpOnly; SameSite=Lax",
    ]);
  });
});

describe("storeResponseCookies", () => {
  it("stores each cookie once and renders a request cookie header", () => {
    const jar = new Map<string, string>();
    const headers = new Headers();
    (
      headers as Headers & {
        getSetCookie: () => string[];
      }
    ).getSetCookie = () => [
      "csrf-token=abc; Path=/; HttpOnly; Expires=Wed, 01 Jan 2030 00:00:00 GMT",
      "authjs.session-token=xyz; Path=/; HttpOnly; SameSite=Lax",
    ];
    const response = { headers } as Response;

    storeResponseCookies(jar, response);

    expect(jar.get("csrf-token")).toBe("abc");
    expect(jar.get("authjs.session-token")).toBe("xyz");
    expect(cookieHeader(jar)).toContain("csrf-token=abc");
    expect(cookieHeader(jar)).toContain("authjs.session-token=xyz");
  });
});
