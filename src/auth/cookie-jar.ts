export type CookieJar = Map<string, string>;

function looksLikeCookieBoundary(value: string): boolean {
  return /^\s*[^=;,\s]+=[^;]*$/.test(value.trimStart().split(";", 1)[0] ?? "");
}

export function splitSetCookieHeader(header: string): string[] {
  const cookies: string[] = [];
  let start = 0;

  for (let index = 0; index < header.length; index += 1) {
    if (header[index] !== ",") continue;

    const nextValue = header.slice(index + 1);
    if (!looksLikeCookieBoundary(nextValue)) continue;

    const cookie = header.slice(start, index).trim();
    if (cookie) cookies.push(cookie);
    start = index + 1;
  }

  const finalCookie = header.slice(start).trim();
  if (finalCookie) cookies.push(finalCookie);
  return cookies;
}

export function readSetCookies(headers: Headers): string[] {
  const withHelper = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withHelper.getSetCookie === "function") {
    return withHelper.getSetCookie();
  }

  const combined = headers.get("set-cookie");
  return combined ? splitSetCookieHeader(combined) : [];
}

export function storeResponseCookies(jar: CookieJar, response: Response): void {
  for (const header of readSetCookies(response.headers)) {
    const [pair] = header.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    jar.set(name, value);
  }
}

export function cookieHeader(jar: CookieJar): string {
  return Array.from(jar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}
