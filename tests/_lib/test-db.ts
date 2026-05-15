/**
 * Shared test database connection + cleanup helper.
 *
 * Every test file that touches the DB should:
 *   import { testSql as sql, truncateAll } from "../_lib/test-db";
 *
 * `truncateAll(sql)` wipes every test-mutable table in FK-safe order so
 * `beforeEach` can start from a clean slate without per-file DELETE chains.
 * Pass `{ preserveReadOnlyTables: false }` when a suite must be isolated from
 * startup seed state as well (for example when it seeds its own role slugs and
 * needs exact counts rather than "at least" assertions).
 *
 * Tables in `READ_ONLY_TABLES` are preserved by default because they hold
 * startup seed data the system loads once (role_templates synced from
 * role-library/, etc.). Suites that need deterministic fixture isolation from
 * those rows must opt into the full reset path described above.
 *
 * Pool lifecycle: `testSql` is a process-wide singleton (one pool, shared
 * across every test file). Vitest's globalSetup teardown calls
 * `closeTestSql()` exactly once at end-of-run. Per-file `afterAll` blocks
 * MUST NOT close the pool — doing so breaks every subsequent test file.
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import postgres from "postgres";
import { invalidateAll as invalidateProvisionCache } from "../../src/provisioning/status-cache";
import { syncRoleLibrary } from "../../src/roles/sync";

const TEST_DB_NAME_PREFIX = "hivewrightv2_test";
const SOURCE_VAR = process.env.TEST_DATABASE_URL
  ? "TEST_DATABASE_URL"
  : process.env.DATABASE_URL
    ? "DATABASE_URL"
    : "default";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  `postgresql://hivewright:hivewright@localhost:5432/${TEST_DB_NAME_PREFIX}`;

const testDbName = (() => {
  const pathname = new URL(TEST_DB_URL).pathname.replace(/^\//, "");
  return decodeURIComponent(pathname);
})();

if (!testDbName.startsWith(TEST_DB_NAME_PREFIX)) {
  throw new Error(
    `[test-db] refusing to connect: effective URL (from ${SOURCE_VAR}) ` +
      `'${TEST_DB_URL}' does not name a ${TEST_DB_NAME_PREFIX} database. ` +
      `Tests must never run against prod.`,
  );
}

export const testSql = postgres(TEST_DB_URL, { max: 5 });
type ReservedTestSql = Awaited<ReturnType<typeof testSql.reserve>>;

/**
 * Tables that hold seed/system data tests should not wipe.
 *
 * `__drizzle_migrations` is defense-in-depth: drizzle places it in the
 * `drizzle` schema, so the schemaname filter in truncateAll() already
 * excludes it. Listing it here keeps the intent visible if a future
 * drizzle version moves it into public, or if someone broadens the
 * schema filter.
 */
const READ_ONLY_TABLES: ReadonlySet<string> = new Set([
  "role_templates",
  "__drizzle_migrations",
]);
let roleSeedMayBeMissing = false;

export interface TruncateAllOptions {
  preserveReadOnlyTables?: boolean;
}

export interface FixtureNamespace {
  key: string;
  email(label: string): string;
  slug(label: string): string;
  uuid(label: string): string;
}

export interface TestDbIsolationLease {
  release(): Promise<void>;
}

export interface TestModelRoutingFixtureOptions {
  provider?: string;
  adapterType?: string;
  modelId?: string;
}

let fixtureNamespaceCounter = 0;
const FIXTURE_RUN_ID = randomUUID();
const fixtureNamespaceCountersByContext = new Map<string, number>();
let testDbLockConnection: ReservedTestSql | null = null;
let testDbLockReleased = false;
const ISOLATED_SUITE_LOCK_IDS = (() => {
  const digest = createHash("sha256")
    .update(`${testDbName}:isolated-suite-lock`)
    .digest("hex");

  return [
    Number.parseInt(digest.slice(0, 8), 16) | 0,
    Number.parseInt(digest.slice(8, 16), 16) | 0,
  ] as const;
})();

function testDbLockKeySql(sql: typeof testSql | ReservedTestSql) {
  return sql`hashtext(${testDbName})::bigint`;
}

const testDbLockPromise = (async () => {
  if (process.env.VITEST_WORKER_ID !== undefined) {
    return;
  }

  const connection = await testSql.reserve();

  try {
    await connection`SELECT pg_advisory_lock(${testDbLockKeySql(connection)})`;
    testDbLockConnection = connection;
    testDbLockReleased = false;
  } catch (error) {
    connection.release();
    throw error;
  }
})();

await testDbLockPromise;

function compactFixtureLabel(label: string): string {
  const compact = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return compact || "fixture";
}

function fixtureDigest(scope: string, label: string): string {
  return createHash("sha256")
    .update(`${FIXTURE_RUN_ID}:${scope}:${label}`)
    .digest("hex");
}

function getActiveVitestContext(): string | null {
  const expectApi = (globalThis as {
    expect?: {
      getState?: () => {
        currentTestName?: string;
        testPath?: string;
      };
    };
  }).expect;

  const state = expectApi?.getState?.();
  const currentTestName = state?.currentTestName?.trim();
  const testPath = state?.testPath?.trim();

  if (!currentTestName) {
    return null;
  }

  return [testPath, currentTestName].filter(Boolean).join(":");
}

/**
 * Creates a per-test fixture namespace so suites do not depend on fixed
 * emails/UUIDs/slugs that can collide with stale rows from earlier tests or
 * previous runs. `truncateAll()` still clears semantic state; the namespace is
 * defense-in-depth for unique keys and PKs.
 */
export function createFixtureNamespace(scope: string): FixtureNamespace {
  const compactScope = compactFixtureLabel(scope);
  const activeContext = getActiveVitestContext();
  const contextKey = activeContext ? `${activeContext}:${compactScope}` : compactScope;
  const ordinal = activeContext
    ? (fixtureNamespaceCountersByContext.get(contextKey) ?? 0) + 1
    : ++fixtureNamespaceCounter;

  if (activeContext) {
    fixtureNamespaceCountersByContext.set(contextKey, ordinal);
  }

  const scopedKey = activeContext
    ? `${compactScope}-${fixtureDigest("vitest-context", activeContext).slice(0, 12)}-${ordinal}`
    : `${compactScope}-${ordinal}`;

  return {
    key: scopedKey,
    email(label: string): string {
      const compact = compactFixtureLabel(label);
      const digest = fixtureDigest(scopedKey, compact).slice(0, 12);
      return `${scopedKey}-${compact}-${digest}@hivewright.test`;
    },
    slug(label: string): string {
      const compact = compactFixtureLabel(label);
      const digest = fixtureDigest(scopedKey, compact).slice(0, 10);
      return `${scopedKey}-${compact}-${digest}`.slice(0, 63);
    },
    uuid(label: string): string {
      const digest = fixtureDigest(scopedKey, compactFixtureLabel(label));
      return [
        digest.slice(0, 8),
        digest.slice(8, 12),
        `4${digest.slice(13, 16)}`,
        `8${digest.slice(17, 20)}`,
        digest.slice(20, 32),
      ].join("-");
    },
  };
}

/**
 * Seed the minimal per-hive model-routing fixture needed by tests that build
 * dispatcher sessions. Role-library roles now default to automatic routing;
 * after a DB reset there are intentionally no hive-specific model candidates,
 * so tests that exercise session construction must opt in to a healthy route.
 */
export async function seedTestModelRoutingForHive(
  hiveId: string,
  sql = testSql,
  options: TestModelRoutingFixtureOptions = {},
): Promise<void> {
  const provider = options.provider ?? "anthropic";
  const adapterType = options.adapterType ?? "claude-code";
  const modelId = options.modelId ?? "anthropic/claude-sonnet-4-6";
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([
      "runtime",
      provider.trim().toLowerCase(),
      adapterType.trim().toLowerCase(),
      "",
    ]))
    .digest("hex");

  await sql`
    INSERT INTO hive_models (
      hive_id,
      provider,
      model_id,
      adapter_type,
      capabilities,
      fallback_priority,
      enabled,
      benchmark_quality_score,
      routing_cost_score
    )
    VALUES (
      ${hiveId},
      ${provider},
      ${modelId},
      ${adapterType},
      ${sql.json(["text", "code"])},
      1,
      true,
      80,
      20
    )
    ON CONFLICT (hive_id, provider, model_id) DO UPDATE SET
      adapter_type = EXCLUDED.adapter_type,
      capabilities = EXCLUDED.capabilities,
      fallback_priority = EXCLUDED.fallback_priority,
      enabled = EXCLUDED.enabled,
      benchmark_quality_score = EXCLUDED.benchmark_quality_score,
      routing_cost_score = EXCLUDED.routing_cost_score,
      updated_at = NOW()
  `;

  await sql`
    INSERT INTO model_health (
      fingerprint,
      model_id,
      status,
      last_probed_at,
      next_probe_at,
      latency_ms
    )
    VALUES (
      ${fingerprint},
      ${modelId},
      'healthy',
      NOW(),
      NOW() + INTERVAL '1 hour',
      100
    )
    ON CONFLICT (fingerprint, model_id) DO UPDATE SET
      status = EXCLUDED.status,
      last_probed_at = EXCLUDED.last_probed_at,
      next_probe_at = EXCLUDED.next_probe_at,
      latency_ms = EXCLUDED.latency_ms,
      updated_at = NOW()
  `;

  await sql`
    DELETE FROM adapter_config
    WHERE hive_id = ${hiveId}
      AND adapter_type = 'model-routing'
  `;

  await sql`
    INSERT INTO adapter_config (hive_id, adapter_type, config)
    VALUES (${hiveId}, 'model-routing', ${sql.json({})})
  `;
}

/**
 * Acquires an advisory lock that gives a suite exclusive ownership of the
 * shared test database for its full lifetime.
 *
 * Use this only for suites that both:
 * 1. fully reset shared tables via `truncateAll(..., { preserveReadOnlyTables: false })`, and
 * 2. query global counts/rows that another concurrent suite could perturb.
 *
 * The lock is intentionally global across every caller: these suites are fast,
 * but they need deterministic isolation more than parallelism.
 */
export async function acquireSuiteIsolation(
  sql = testSql,
): Promise<TestDbIsolationLease> {
  const connection = await sql.reserve();
  let released = false;

  await connection`
    SELECT pg_advisory_lock(${ISOLATED_SUITE_LOCK_IDS[0]}, ${ISOLATED_SUITE_LOCK_IDS[1]})
  `;

  return {
    async release(): Promise<void> {
      if (released) {
        return;
      }
      released = true;

      try {
        await connection`
          SELECT pg_advisory_unlock(${ISOLATED_SUITE_LOCK_IDS[0]}, ${ISOLATED_SUITE_LOCK_IDS[1]})
        `;
      } finally {
        await connection.release();
      }
    },
  };
}

/**
 * Truncates every writable table in the public schema in a single statement
 * (TRUNCATE ... CASCADE handles FK ordering automatically). RESTART IDENTITY
 * resets bigserial sequences so test outputs are deterministic.
 */
export async function truncateAll(
  sql = testSql,
  options: TruncateAllOptions = {},
): Promise<void> {
  const { preserveReadOnlyTables = true } = options;
  const rows = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;
  const targets = rows
    .map((r) => r.tablename)
    .filter((t) => !preserveReadOnlyTables || !READ_ONLY_TABLES.has(t))
    .map((t) => `"${t}"`);
  if (targets.length === 0) return;
  await sql.unsafe(
    `TRUNCATE TABLE ${targets.join(", ")} RESTART IDENTITY CASCADE`,
  );

  if (!preserveReadOnlyTables) {
    roleSeedMayBeMissing = true;
  } else {
    const [roleSeed] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM role_templates WHERE slug = 'dev-agent'
      ) AS exists
    `;

    if (roleSeedMayBeMissing || !roleSeed?.exists) {
      await syncRoleLibrary(path.resolve(process.cwd(), "role-library"), sql);
      await sql`
        UPDATE role_templates SET concurrency_limit = 50 WHERE slug = 'goal-supervisor'
      `;
      await sql`
        UPDATE role_templates SET concurrency_limit = 1 WHERE slug IN ('doctor', 'hive-supervisor')
      `;
      await sql`
        UPDATE role_templates
        SET concurrency_limit = 3
        WHERE slug IN (
          'dev-agent',
          'security-auditor',
          'research-analyst',
          'design-agent',
          'data-analyst',
          'content-writer',
          'infrastructure-agent',
          'code-review-agent',
          'qa',
          'content-review-agent'
        )
      `;
    }
    roleSeedMayBeMissing = false;
  }
}

/**
 * Closes the shared pool. Idempotent.
 *
 * Call ONLY from vitest's globalSetup teardown (see vitest.global-setup.ts),
 * NEVER from a per-file `afterAll`. The pool is shared across every test
 * file in the run — the first file to close it will break every subsequent
 * file with "connection closed".
 */
export async function closeTestSql(): Promise<void> {
  try {
    await testDbLockPromise;

    if (testDbLockConnection && !testDbLockReleased) {
      await testDbLockConnection`
        SELECT pg_advisory_unlock(${testDbLockKeySql(testDbLockConnection)})
      `;
      testDbLockConnection.release();
      testDbLockReleased = true;
      testDbLockConnection = null;
    }
  } catch {
    // If the advisory lock was never acquired, ending the pool is still safe.
  }

  await testSql.end({ timeout: 5 });
}

/**
 * Re-export for tests that want to wipe the in-process provision cache.
 * The cache is process-global; without this, status from one test leaks
 * into another. Most tests can rely on `truncateAll` to clear DB rows;
 * tests that hit /api/roles or its provision route should also call
 * `invalidateProvisionCache()` in their `beforeEach`.
 */
export { invalidateProvisionCache };
