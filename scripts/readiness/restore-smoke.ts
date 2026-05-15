import { spawnSync } from "node:child_process";

const dumpIndex = process.argv.indexOf("--dump");
const dbIndex = process.argv.indexOf("--throwaway-db");
const dumpPath = dumpIndex >= 0 ? process.argv[dumpIndex + 1] : undefined;
const throwawayDb = dbIndex >= 0 ? process.argv[dbIndex + 1] : undefined;
if (!dumpPath || !throwawayDb) {
  console.error("Usage: tsx scripts/readiness/restore-smoke.ts --dump <dump-path> --throwaway-db <postgres-url>");
  process.exit(1);
}

function postgresEnvFromUrl(rawUrl: string): NodeJS.ProcessEnv {
  const url = new URL(rawUrl);
  const database = url.pathname.replace(/^\//, "");
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: database,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
  };
}

function assertThrowawayDatabase(rawUrl: string): void {
  const url = new URL(rawUrl);
  const database = url.pathname.replace(/^\//, "");
  const safeName = /(^|[_-])(throwaway|restore[_-]?smoke|test|tmp|temp)([_-]|$)/i.test(database)
    || /^(throwaway|restore[_-]?smoke|test|tmp|temp)/i.test(database);
  if (!safeName || process.env.HIVEWRIGHT_ALLOW_RESTORE_SMOKE !== "yes") {
    console.error([
      "Refusing destructive restore smoke.",
      `Database name must clearly be disposable/test-only; got: ${database || "<empty>"}`,
      "Set HIVEWRIGHT_ALLOW_RESTORE_SMOKE=yes after verifying the URL points to a throwaway database.",
    ].join("\n"));
    process.exit(2);
  }
}

assertThrowawayDatabase(throwawayDb);
const env = postgresEnvFromUrl(throwawayDb);
const restore = spawnSync("pg_restore", ["--clean", "--if-exists", "--no-owner", "--dbname", env.PGDATABASE ?? "" , dumpPath], {
  stdio: "inherit",
  env,
});
if (restore.status !== 0) process.exit(restore.status ?? 1);
const smoke = spawnSync("psql", ["-Atc", "select count(*)::int from information_schema.tables where table_schema = 'public';"], {
  encoding: "utf8",
  env,
});
const tableCount = Number(smoke.stdout.trim());
if (smoke.status !== 0 || !Number.isFinite(tableCount) || tableCount <= 0) {
  console.error(smoke.stderr || smoke.stdout || "restore smoke failed: no public tables restored");
  process.exit(smoke.status ?? 1);
}
console.log(JSON.stringify({ status: "pass", publicTableCount: tableCount }, null, 2));
