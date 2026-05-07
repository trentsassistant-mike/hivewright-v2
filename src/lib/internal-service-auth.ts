const BEARER_PREFIX = "Bearer ";

function constantTimeEquals(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);

  let diff = leftBytes.length ^ rightBytes.length;
  for (let i = 0; i < maxLength; i += 1) {
    diff |= (leftBytes[i] ?? 0) ^ (rightBytes[i] ?? 0);
  }

  return diff === 0;
}

export function getBearerToken(authorizationHeader: string | null | undefined): string | null {
  if (!authorizationHeader) return null;
  if (!authorizationHeader.startsWith(BEARER_PREFIX)) return null;

  const token = authorizationHeader.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export function normalizeInternalServiceToken(token: string | null | undefined): string | null {
  if (typeof token !== "string") return null;
  const normalized = token.trim();
  return normalized.length > 0 ? normalized : null;
}

export function buildInternalServiceAuthorizationHeader(
  token: string | null | undefined,
): string | null {
  const normalizedToken = normalizeInternalServiceToken(token);
  return normalizedToken ? `${BEARER_PREFIX}${normalizedToken}` : null;
}

export function hasValidInternalServiceBearer(
  authorizationHeader: string | null | undefined,
  expectedToken: string | null | undefined,
): boolean {
  const normalizedExpectedToken = normalizeInternalServiceToken(expectedToken);
  if (!normalizedExpectedToken) return false;

  const bearerToken = getBearerToken(authorizationHeader);
  if (!bearerToken) return false;

  return constantTimeEquals(bearerToken, normalizedExpectedToken);
}
