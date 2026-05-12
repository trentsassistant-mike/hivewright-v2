const SENSITIVE_KEY_PATTERN = /(?:token|secret|password|api[_-]?key|authorization|authHeader|private[_-]?key|client[_-]?secret|signature|webhook[_-]?url)/i;
const SENSITIVE_QUERY_PARAM_PATTERN = /([?&](?:token|key|api_key|apikey|secret|signature|code|auth|authorization|access_token|refresh_token)=)[^&#\s]+/gi;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const BASIC_PATTERN = /Basic\s+[A-Za-z0-9._~+\/-]+=*/gi;
const KEY_VALUE_SECRET_PATTERN = /((?:token|api[_-]?key|secret|password|authorization|authHeader|signature)\s*[=:]\s*)[^\s,;]+/gi;
const WEBHOOK_URL_PATTERN = /https?:\/\/[^\s"'<>]*(?:webhook|hooks\.slack|discord(?:app)?\.com\/api\/webhooks)[^\s"'<>]*/gi;

export function sanitizeAuditString(value: string): string {
  return value
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(BASIC_PATTERN, "Basic [REDACTED]")
    .replace(WEBHOOK_URL_PATTERN, "[REDACTED_URL]")
    .replace(SENSITIVE_QUERY_PARAM_PATTERN, "$1[REDACTED]")
    .replace(KEY_VALUE_SECRET_PATTERN, "$1[REDACTED]");
}

export function redactActionPayload(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeAuditString(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactActionPayload(item));

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    output[key] = redactActionPayload(child);
  }
  return output;
}
