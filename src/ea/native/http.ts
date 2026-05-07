import { randomUUID } from "node:crypto";

export type EaCreateRoute = "/api/work" | "/api/goals" | "/api/tasks";

export interface EaCreateRequestOptions {
  apiBaseUrl: string;
  route: EaCreateRoute;
  body: unknown;
  token: string;
  maxAttempts?: number;
  auditHeaders?: {
    sourceHiveId?: string | null;
    threadId?: string | null;
    ownerMessageId?: string | null;
    source?: string | null;
  };
}

export async function postEaCreateRequest(options: EaCreateRequestOptions): Promise<Response> {
  const idempotencyKey = randomUUID();
  const maxAttempts = Math.max(1, options.maxAttempts ?? 1);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(new URL(options.route, options.apiBaseUrl), {
        method: "POST",
        headers: buildEaCreateHeaders(options, idempotencyKey),
        body: JSON.stringify(options.body),
      });

      if (response.status < 500 || attempt === maxAttempts) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("EA create request failed");
}

function buildEaCreateHeaders(
  options: Pick<EaCreateRequestOptions, "token" | "auditHeaders">,
  idempotencyKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${options.token}`,
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
  };

  const audit = options.auditHeaders;
  if (audit?.sourceHiveId) headers["X-HiveWright-EA-Source-Hive-Id"] = audit.sourceHiveId;
  if (audit?.threadId) headers["X-HiveWright-EA-Thread-Id"] = audit.threadId;
  if (audit?.ownerMessageId) headers["X-HiveWright-EA-Owner-Message-Id"] = audit.ownerMessageId;
  if (audit?.source) headers["X-HiveWright-EA-Source"] = audit.source;

  return headers;
}
