import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { resolveHivewrightRuntimeRoot } from "@/runtime/paths";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required to create a readiness backup.");
  process.exit(1);
}

function postgresEnvFromUrl(rawUrl: string): NodeJS.ProcessEnv {
  const url = new URL(rawUrl);
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: url.pathname.replace(/^\//, ""),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
  };
}

const backupDir = path.join(resolveHivewrightRuntimeRoot(), "backups", "readiness");
mkdirSync(backupDir, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputPath = path.join(backupDir, `hivewright-${timestamp}.dump`);
const result = spawnSync("pg_dump", ["--format=custom", "--file", outputPath], {
  stdio: "inherit",
  env: postgresEnvFromUrl(databaseUrl),
});
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(outputPath);
