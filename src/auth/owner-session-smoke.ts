import postgres from "postgres";
import {
  assertLocalOwnerSessionResetAllowed,
  DEFAULT_LOCAL_OWNER_DISPLAY_NAME,
  DEFAULT_LOCAL_OWNER_EMAIL,
  seedLocalOwnerSession,
} from "./local-owner-session";
import {
  type CookieJar,
  cookieHeader,
  storeResponseCookies,
} from "./cookie-jar";
import {
  normalizeLocalAppOrigin,
  resolveLocalAppOrigin,
} from "./local-origin";

export const DEFAULT_OWNER_SESSION_DATABASE_URL =
  "postgresql://hivewright:hivewright@localhost:5432/hivewright";
export const OWNER_SESSION_SMOKE_HIVE_SLUG = "owner-session-smoke";
export const OWNER_SESSION_LOCAL_COMMAND = "npm run auth:owner-smoke:local";

export type OwnerSessionSmokeFailureCategory =
  | "env-missing"
  | "app-unreachable"
  | "setup-reset-failure"
  | "auth-failure";

export interface OwnerSessionSmokeErrorShape {
  ok: false;
  category: OwnerSessionSmokeFailureCategory;
  error: string;
  details?: Record<string, unknown>;
}

export interface OwnerSessionSmokeConfig {
  baseUrl: string;
  databaseUrl: string;
  ownerEmail: string;
  ownerPassword: string | null;
  ownerDisplayName: string;
  resetEnabled: boolean;
}

export interface OwnerSessionPreflightResult {
  setupState: {
    needsSetup: boolean;
    userCount: number | null;
  };
}

export interface OwnerSessionResetResult {
  mode: "created" | "updated";
  user: {
    id: string;
    email: string;
    displayName: string | null;
    isSystemOwner: boolean;
  };
}

export interface OwnerSessionSmokeSummary {
  ok: boolean;
  baseUrl: string;
  ownerEmail: string;
  hiveId: string;
  originConsistency: {
    canonicalOrigin: string;
    noHostDrift: boolean;
    unauthenticatedPageRedirect: {
      value: string | null;
      emittedOrigin: string | null;
      normalizedOrigin: string | null;
      hostDrift: boolean;
    };
    loginRedirect: {
      value: string | null;
      emittedOrigin: string | null;
      normalizedOrigin: string | null;
      hostDrift: boolean;
    };
    authenticatedPageRedirect: {
      value: string | null;
      emittedOrigin: string | null;
      normalizedOrigin: string | null;
      hostDrift: boolean;
    };
  };
  checks: {
    unauthenticatedPage: {
      path: "/";
      status: number;
      location: string | null;
    };
    unauthenticatedApi: {
      path: string;
      status: number;
      body: string;
    };
    login: {
      status: number;
      location: string | null;
    };
    authenticatedPage: {
      path: "/";
      status: number;
      location: string | null;
    };
    authenticatedApi: {
      path: string;
      status: number;
      body: string;
    };
  };
}

export interface OwnerSessionLocalSmokeResult {
  ok: true;
  command: string;
  baseUrl: string;
  ownerEmail: string;
  preflight: OwnerSessionPreflightResult;
  reset: OwnerSessionResetResult;
  smoke: OwnerSessionSmokeSummary;
}

export class OwnerSessionSmokeError extends Error {
  readonly category: OwnerSessionSmokeFailureCategory;
  readonly details?: Record<string, unknown>;

  constructor(
    category: OwnerSessionSmokeFailureCategory,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OwnerSessionSmokeError";
    this.category = category;
    this.details = details;
  }

  toJSON(): OwnerSessionSmokeErrorShape {
    return {
      ok: false,
      category: this.category,
      error: this.message,
      details: this.details,
    };
  }
}

export function ownerSessionSmokeError(
  category: OwnerSessionSmokeFailureCategory,
  message: string,
  details?: Record<string, unknown>,
): OwnerSessionSmokeError {
  return new OwnerSessionSmokeError(category, message, details);
}

export function getOwnerSessionSmokeConfig(
  env: NodeJS.ProcessEnv = process.env,
): OwnerSessionSmokeConfig {
  return {
    baseUrl: resolveLocalAppOrigin(env.BASE_URL),
    databaseUrl: env.DATABASE_URL ?? DEFAULT_OWNER_SESSION_DATABASE_URL,
    ownerEmail: env.OWNER_EMAIL?.trim() || DEFAULT_LOCAL_OWNER_EMAIL,
    ownerPassword: env.OWNER_PASSWORD?.trim() || null,
    ownerDisplayName: env.OWNER_DISPLAY_NAME?.trim() || DEFAULT_LOCAL_OWNER_DISPLAY_NAME,
    resetEnabled: env.ALLOW_LOCAL_OWNER_SESSION_RESET === "1",
  };
}

export function serializeOwnerSessionSmokeError(error: unknown): OwnerSessionSmokeErrorShape {
  if (error instanceof OwnerSessionSmokeError) {
    return error.toJSON();
  }

  return {
    ok: false,
    category: "setup-reset-failure",
    error: error instanceof Error ? error.message : String(error),
  };
}

export function assertOwnerSessionSmokeEnv(
  config: OwnerSessionSmokeConfig,
  options: { requireReset: boolean },
): void {
  if (!config.ownerPassword) {
    throw ownerSessionSmokeError("env-missing", "OWNER_PASSWORD is required.", {
      requiredEnv: ["OWNER_PASSWORD"],
      command: OWNER_SESSION_LOCAL_COMMAND,
    });
  }

  if (options.requireReset && !config.resetEnabled) {
    throw ownerSessionSmokeError(
      "env-missing",
      "ALLOW_LOCAL_OWNER_SESSION_RESET=1 is required for local owner-session smoke.",
      {
        requiredEnv: ["ALLOW_LOCAL_OWNER_SESSION_RESET"],
        command: OWNER_SESSION_LOCAL_COMMAND,
      },
    );
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function summarizeLocation(baseUrl: string, location: string | null): {
  value: string | null;
  emittedOrigin: string | null;
  normalizedOrigin: string | null;
  hostDrift: boolean;
} {
  if (!location) {
    return {
      value: null,
      emittedOrigin: null,
      normalizedOrigin: null,
      hostDrift: false,
    };
  }

  const url = new URL(location, baseUrl);
  const normalizedOrigin = normalizeLocalAppOrigin(url.origin);
  return {
    value: url.toString(),
    emittedOrigin: url.origin,
    normalizedOrigin,
    hostDrift: url.origin !== baseUrl,
  };
}

export async function preflightOwnerSessionLocalSmoke(
  config: OwnerSessionSmokeConfig,
  deps: {
    fetchImpl?: typeof fetch;
  } = {},
): Promise<OwnerSessionPreflightResult> {
  assertOwnerSessionSmokeEnv(config, { requireReset: true });

  const fetchImpl = deps.fetchImpl ?? fetch;
  const setupStateUrl = `${config.baseUrl}/api/auth/setup-state`;

  let response: Response;
  try {
    response = await fetchImpl(setupStateUrl, { redirect: "manual" });
  } catch (error) {
    throw ownerSessionSmokeError(
      "app-unreachable",
      `Owner-session smoke could not reach ${setupStateUrl}. Start the app and retry.`,
      {
        baseUrl: config.baseUrl,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }

  if (!response.ok) {
    const body = await readJsonBody(response);
    throw ownerSessionSmokeError(
      "setup-reset-failure",
      `GET /api/auth/setup-state returned ${response.status}.`,
      {
        baseUrl: config.baseUrl,
        status: response.status,
        body,
      },
    );
  }

  const body = (await response.json()) as { data?: { needsSetup?: unknown; userCount?: unknown } };
  const data = asObject(body.data);
  const needsSetup = data?.needsSetup;
  const userCount = data?.userCount;

  if (typeof needsSetup !== "boolean") {
    throw ownerSessionSmokeError(
      "setup-reset-failure",
      "GET /api/auth/setup-state returned an invalid payload.",
      {
        baseUrl: config.baseUrl,
        body,
      },
    );
  }

  if (needsSetup) {
    throw ownerSessionSmokeError(
      "setup-reset-failure",
      "GET /api/auth/setup-state reported needsSetup=true. Complete or repair bootstrap before smoke.",
      {
        baseUrl: config.baseUrl,
        body,
      },
    );
  }

  return {
    setupState: {
      needsSetup,
      userCount: typeof userCount === "number" ? userCount : null,
    },
  };
}

export async function resetOwnerSessionLocalFixture(
  config: OwnerSessionSmokeConfig,
): Promise<OwnerSessionResetResult> {
  assertOwnerSessionSmokeEnv(config, { requireReset: true });

  try {
    assertLocalOwnerSessionResetAllowed(config.databaseUrl);
  } catch (error) {
    throw ownerSessionSmokeError(
      "setup-reset-failure",
      error instanceof Error ? error.message : String(error),
      {
        databaseUrl: config.databaseUrl,
      },
    );
  }

  const sql = postgres(config.databaseUrl, { max: 1 });
  try {
    return await seedLocalOwnerSession(sql, {
      email: config.ownerEmail,
      password: config.ownerPassword!,
      displayName: config.ownerDisplayName,
    });
  } catch (error) {
    throw ownerSessionSmokeError(
      "setup-reset-failure",
      error instanceof Error ? error.message : String(error),
      {
        databaseUrl: config.databaseUrl,
        ownerEmail: config.ownerEmail,
      },
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function ensureOwnerSessionSmokeHive(
  config: OwnerSessionSmokeConfig,
): Promise<string> {
  const sql = postgres(config.databaseUrl, { max: 1 });
  try {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type, description, is_system_fixture)
      VALUES (${OWNER_SESSION_SMOKE_HIVE_SLUG}, 'Owner Session Smoke', 'digital', 'Local auth smoke fixture', true)
      ON CONFLICT (slug) DO UPDATE
      SET name = EXCLUDED.name,
          type = EXCLUDED.type,
          description = EXCLUDED.description,
          is_system_fixture = EXCLUDED.is_system_fixture
      RETURNING id
    `;
    return row.id;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function getCsrfToken(
  config: OwnerSessionSmokeConfig,
  jar: CookieJar,
  fetchImpl: typeof fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/api/auth/csrf`, {
      headers: cookieHeader(jar) ? { cookie: cookieHeader(jar) } : undefined,
    });
  } catch (error) {
    throw ownerSessionSmokeError(
      "app-unreachable",
      `GET /api/auth/csrf failed because ${config.baseUrl} is unreachable.`,
      {
        baseUrl: config.baseUrl,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }

  storeResponseCookies(jar, response);
  if (!response.ok) {
    throw ownerSessionSmokeError(
      "auth-failure",
      `GET /api/auth/csrf failed with ${response.status}.`,
      {
        baseUrl: config.baseUrl,
        status: response.status,
      },
    );
  }

  const body = (await response.json()) as { csrfToken?: string };
  if (!body.csrfToken) {
    throw ownerSessionSmokeError("auth-failure", "CSRF token missing from /api/auth/csrf response.", {
      baseUrl: config.baseUrl,
    });
  }

  return body.csrfToken;
}

async function signIn(
  config: OwnerSessionSmokeConfig,
  jar: CookieJar,
  fetchImpl: typeof fetch,
): Promise<{ status: number; location: string | null }> {
  const csrfToken = await getCsrfToken(config, jar, fetchImpl);
  const body = new URLSearchParams({
    email: config.ownerEmail,
    password: config.ownerPassword ?? "",
    csrfToken,
    callbackUrl: `${config.baseUrl}/`,
    json: "true",
  });

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/api/auth/callback/credentials`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieHeader(jar),
      },
      body,
    });
  } catch (error) {
    throw ownerSessionSmokeError(
      "app-unreachable",
      `POST /api/auth/callback/credentials failed because ${config.baseUrl} is unreachable.`,
      {
        baseUrl: config.baseUrl,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }

  storeResponseCookies(jar, response);
  return {
    status: response.status,
    location: response.headers.get("location"),
  };
}

export async function runOwnerSessionSmokeChecks(
  config: OwnerSessionSmokeConfig,
  deps: {
    fetchImpl?: typeof fetch;
    ensureSmokeHiveImpl?: (config: OwnerSessionSmokeConfig) => Promise<string>;
  } = {},
): Promise<OwnerSessionSmokeSummary> {
  assertOwnerSessionSmokeEnv(config, { requireReset: false });

  const fetchImpl = deps.fetchImpl ?? fetch;
  const ensureSmokeHiveImpl = deps.ensureSmokeHiveImpl ?? ensureOwnerSessionSmokeHive;
  const hiveId = await ensureSmokeHiveImpl(config);
  const jar: CookieJar = new Map();

  const safeFetch = async (url: string, init?: RequestInit) => {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      throw ownerSessionSmokeError(
        "app-unreachable",
        `Owner-session smoke could not reach ${url}.`,
        {
          baseUrl: config.baseUrl,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  };

  const unauthPage = await safeFetch(`${config.baseUrl}/`, { redirect: "manual" });
  const unauthApi = await safeFetch(
    `${config.baseUrl}/api/dashboard/summary?hiveId=${encodeURIComponent(hiveId)}`,
    { redirect: "manual" },
  );
  const login = await signIn(config, jar, fetchImpl);
  const authPage = await safeFetch(`${config.baseUrl}/`, {
    redirect: "manual",
    headers: { cookie: cookieHeader(jar) },
  });
  const authApi = await safeFetch(
    `${config.baseUrl}/api/dashboard/summary?hiveId=${encodeURIComponent(hiveId)}`,
    {
      redirect: "manual",
      headers: { cookie: cookieHeader(jar) },
    },
  );

  const unauthApiBody = await unauthApi.text();
  const authApiBody = await authApi.text();
  const loginLocation = summarizeLocation(config.baseUrl, login.location);
  const unauthPageLocation = summarizeLocation(
    config.baseUrl,
    unauthPage.headers.get("location"),
  );
  const authPageLocation = summarizeLocation(
    config.baseUrl,
    authPage.headers.get("location"),
  );
  const noHostDrift =
    !loginLocation.hostDrift &&
    !unauthPageLocation.hostDrift &&
    !authPageLocation.hostDrift;

  const summary: OwnerSessionSmokeSummary = {
    ok:
      unauthPage.status === 307 &&
      unauthPageLocation.value?.endsWith("/login") === true &&
      unauthApi.status === 401 &&
      login.status === 302 &&
      loginLocation.emittedOrigin === config.baseUrl &&
      loginLocation.normalizedOrigin === config.baseUrl &&
      authPage.status === 200 &&
      authApi.status === 200 &&
      noHostDrift,
    baseUrl: config.baseUrl,
    ownerEmail: config.ownerEmail,
    hiveId,
    originConsistency: {
      canonicalOrigin: config.baseUrl,
      noHostDrift,
      unauthenticatedPageRedirect: unauthPageLocation,
      loginRedirect: loginLocation,
      authenticatedPageRedirect: authPageLocation,
    },
    checks: {
      unauthenticatedPage: {
        path: "/",
        status: unauthPage.status,
        location: unauthPageLocation.value,
      },
      unauthenticatedApi: {
        path: `/api/dashboard/summary?hiveId=${hiveId}`,
        status: unauthApi.status,
        body: unauthApiBody,
      },
      login,
      authenticatedPage: {
        path: "/",
        status: authPage.status,
        location: authPageLocation.value,
      },
      authenticatedApi: {
        path: `/api/dashboard/summary?hiveId=${hiveId}`,
        status: authApi.status,
        body: authApiBody,
      },
    },
  };

  if (!summary.ok) {
    throw ownerSessionSmokeError(
      "auth-failure",
      "Owner-session auth smoke assertions failed.",
      {
        summary,
      },
    );
  }

  return summary;
}

export async function runOwnerSessionLocalSmoke(
  config: OwnerSessionSmokeConfig,
  deps: {
    fetchImpl?: typeof fetch;
    preflightImpl?: (config: OwnerSessionSmokeConfig) => Promise<OwnerSessionPreflightResult>;
    resetImpl?: (config: OwnerSessionSmokeConfig) => Promise<OwnerSessionResetResult>;
    smokeImpl?: (config: OwnerSessionSmokeConfig) => Promise<OwnerSessionSmokeSummary>;
  } = {},
): Promise<OwnerSessionLocalSmokeResult> {
  const preflightImpl =
    deps.preflightImpl ?? ((nextConfig) => preflightOwnerSessionLocalSmoke(nextConfig, deps));
  const resetImpl = deps.resetImpl ?? resetOwnerSessionLocalFixture;
  const smokeImpl =
    deps.smokeImpl ?? ((nextConfig) => runOwnerSessionSmokeChecks(nextConfig, deps));

  const preflight = await preflightImpl(config);
  const reset = await resetImpl(config);
  const smoke = await smokeImpl(config);

  return {
    ok: true,
    command: OWNER_SESSION_LOCAL_COMMAND,
    baseUrl: config.baseUrl,
    ownerEmail: config.ownerEmail,
    preflight,
    reset,
    smoke,
  };
}
