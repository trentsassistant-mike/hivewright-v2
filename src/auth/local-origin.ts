const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const DEFAULT_LOCAL_APP_ORIGIN = "http://127.0.0.1:3002";

function canonicalLoopbackHostname(protocol: string): string {
  return protocol === "http:" ? "127.0.0.1" : "localhost";
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function normalizeLocalAppOrigin(origin: string): string {
  const url = new URL(origin);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return url.origin;
  }

  url.hostname = canonicalLoopbackHostname(url.protocol);
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }

  return url.origin;
}

export function resolveLocalAppOrigin(origin?: string | null): string {
  const candidate = origin?.trim();
  if (!candidate) {
    return DEFAULT_LOCAL_APP_ORIGIN;
  }

  return isLoopbackOrigin(candidate)
    ? normalizeLocalAppOrigin(candidate)
    : new URL(candidate).origin;
}

export function normalizeLocalAuthOriginEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const canonicalOrigin = resolveLocalAppOrigin(
    env.AUTH_URL ?? env.NEXTAUTH_URL ?? env.BASE_URL,
  );

  if (isLoopbackOrigin(canonicalOrigin)) {
    env.AUTH_URL = canonicalOrigin;
    env.NEXTAUTH_URL = canonicalOrigin;
    if (!env.BASE_URL || isLoopbackOrigin(env.BASE_URL)) {
      env.BASE_URL = canonicalOrigin;
    }
  }

  return canonicalOrigin;
}

export function normalizeLocalRedirectUrl(url: string, baseUrl: string): string {
  const canonicalBaseUrl = isLoopbackOrigin(baseUrl)
    ? normalizeLocalAppOrigin(baseUrl)
    : new URL(baseUrl).origin;
  const resolved = new URL(url, canonicalBaseUrl);
  const normalizedOrigin = isLoopbackOrigin(resolved.origin)
    ? normalizeLocalAppOrigin(resolved.origin)
    : resolved.origin;

  if (resolved.origin !== normalizedOrigin) {
    resolved.protocol = new URL(normalizedOrigin).protocol;
    resolved.hostname = new URL(normalizedOrigin).hostname;
    resolved.port = new URL(normalizedOrigin).port;
  }

  const normalizedBaseOrigin = new URL(canonicalBaseUrl).origin;
  if (resolved.origin === normalizedBaseOrigin) {
    return resolved.toString();
  }

  return url.startsWith("/") ? resolved.toString() : url;
}
