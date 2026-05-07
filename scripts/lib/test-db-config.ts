import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import postgres from "postgres";

export type TestDatabaseConfig = {
  adminUrl: string;
  testUrl: string;
  databaseName: string;
  source: "env" | "auto";
};

type TestDatabaseEnv = Record<string, string | undefined>;

export const TEST_DB_NAME_PREFIX = "hivewright_test";

function databaseNameFromUrl(url: string) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

export function assertSafeTestDatabaseName(databaseName: string) {
  if (!databaseName.startsWith(TEST_DB_NAME_PREFIX)) {
    throw new Error(
      `[setup-test-db] aborting: '${databaseName}' must start with '${TEST_DB_NAME_PREFIX}'`,
    );
  }
}

export function withDatabase(url: string, databaseName: string) {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function withPgpassPassword(url: string, env: TestDatabaseEnv = process.env) {
  const parsed = new URL(url);
  if (parsed.password) {
    return parsed.toString();
  }

  const host = parsed.hostname || "localhost";
  const port = parsed.port || "5432";
  const database = parsed.pathname.replace(/^\//, "") || "postgres";
  const user = parsed.username || env.PGUSER || env.USER || "postgres";
  const password = pgpassPassword({ host, port, database, user }, env);
  if (password) {
    parsed.username = user;
    parsed.password = password;
  }
  return parsed.toString();
}

export function buildTestDatabaseConfigFromEnv(env: TestDatabaseEnv = process.env): TestDatabaseConfig | null {
  if (!env.TEST_DATABASE_URL && !env.TEST_ADMIN_URL) {
    return null;
  }

  const testUrl = withPgpassPassword(
    env.TEST_DATABASE_URL ?? withDatabase(env.TEST_ADMIN_URL!, TEST_DB_NAME_PREFIX),
    env,
  );
  const databaseName = databaseNameFromUrl(testUrl);
  assertSafeTestDatabaseName(databaseName);

  return {
    adminUrl: withPgpassPassword(env.TEST_ADMIN_URL ?? withDatabase(testUrl, "postgres"), env),
    testUrl,
    databaseName,
    source: "env",
  };
}

function pgpassPassword(
  target: { host: string; port: string; database: string; user: string },
  env: TestDatabaseEnv = process.env,
) {
  const pgpassPath = env.PGPASSFILE ?? path.join(os.homedir(), ".pgpass");
  if (!fs.existsSync(pgpassPath)) {
    return null;
  }

  const lines = fs.readFileSync(pgpassPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.startsWith("#")) {
      continue;
    }
    const [host, port, database, user, ...passwordParts] = line.split(":");
    const password = passwordParts.join(":");
    const matches = (value: string, expected: string) => value === "*" || value === expected;
    if (
      matches(host, target.host) &&
      matches(port, target.port) &&
      matches(database, target.database) &&
      matches(user, target.user)
    ) {
      return password;
    }
  }
  return null;
}

function adminUrlFor(host: string, port: string, user: string, env: TestDatabaseEnv) {
  const parsed = new URL("postgresql://localhost/postgres");
  parsed.hostname = host;
  parsed.port = port;
  parsed.username = user;
  const password = pgpassPassword({ host, port, database: "postgres", user }, env);
  if (password) {
    parsed.password = password;
  }
  return parsed.toString();
}

export function defaultLocalCandidates(env: TestDatabaseEnv = process.env): TestDatabaseConfig[] {
  const ports = Array.from(new Set([env.PGPORT, "5432", "5433"].filter(Boolean))) as string[];
  const users = Array.from(new Set([env.PGUSER, env.USER, "postgres"].filter(Boolean))) as string[];

  return ports.flatMap((port) => users.map((user) => {
    const adminUrl = adminUrlFor("localhost", port, user, env);
    return {
      adminUrl,
      testUrl: withDatabase(adminUrl, TEST_DB_NAME_PREFIX),
      databaseName: TEST_DB_NAME_PREFIX,
      source: "auto" as const,
    };
  }));
}

async function canConnect(adminUrl: string) {
  const sql = postgres(adminUrl, { max: 1, connect_timeout: 2 });
  try {
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

export async function resolveTestDatabaseConfig(env: TestDatabaseEnv = process.env): Promise<TestDatabaseConfig> {
  const explicit = buildTestDatabaseConfigFromEnv(env);
  if (explicit) {
    return explicit;
  }

  for (const candidate of defaultLocalCandidates(env)) {
    if (await canConnect(candidate.adminUrl)) {
      return candidate;
    }
  }

  throw new Error(
    `[setup-test-db] could not connect to a local Postgres admin database. ` +
      `Start Postgres locally or set TEST_ADMIN_URL and TEST_DATABASE_URL. ` +
      `Example: TEST_ADMIN_URL=postgresql://postgres@localhost:5432/postgres ` +
      `TEST_DATABASE_URL=postgresql://postgres@localhost:5432/${TEST_DB_NAME_PREFIX} npm test`,
  );
}
