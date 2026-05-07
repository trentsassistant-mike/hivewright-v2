const DEVELOPMENT_AUTH_SECRET = "dev-secret-change-in-production";
const DEVELOPMENT_DASHBOARD_PASSWORD = "hivewright";

type AuthEnv = Partial<
  Record<"AUTH_SECRET" | "ENCRYPTION_KEY" | "DASHBOARD_PASSWORD" | "NODE_ENV", string>
>;

function readConfiguredValue(value: string | undefined): string | null {
  if (!value || value.trim().length === 0) return null;
  return value;
}

function isDevelopment(env: AuthEnv): boolean {
  return env.NODE_ENV === "development";
}

export function resolveAuthSecret(env: AuthEnv = process.env): string {
  const configuredSecret =
    readConfiguredValue(env.AUTH_SECRET) ??
    readConfiguredValue(env.ENCRYPTION_KEY);

  if (configuredSecret) {
    if (
      configuredSecret === DEVELOPMENT_AUTH_SECRET &&
      !isDevelopment(env)
    ) {
      throw new Error(
        "Unsafe development AUTH_SECRET is not allowed outside NODE_ENV=development.",
      );
    }
    return configuredSecret;
  }

  if (isDevelopment(env)) {
    return DEVELOPMENT_AUTH_SECRET;
  }

  throw new Error(
    "AUTH_SECRET or ENCRYPTION_KEY must be configured outside NODE_ENV=development.",
  );
}

export function resolveBootstrapDashboardPassword(
  env: AuthEnv = process.env,
): string {
  const configuredPassword = readConfiguredValue(env.DASHBOARD_PASSWORD);
  if (configuredPassword) return configuredPassword;

  if (isDevelopment(env)) {
    return DEVELOPMENT_DASHBOARD_PASSWORD;
  }

  throw new Error(
    "DASHBOARD_PASSWORD must be configured before bootstrap login outside NODE_ENV=development.",
  );
}
