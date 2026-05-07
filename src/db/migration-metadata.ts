import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

export const DRIZZLE_MIGRATIONS_SCHEMA = "drizzle";
export const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";
export const APP_MIGRATIONS_TABLE = "__hivewright_app_migrations";

export interface MigrationVersion {
  id: number;
  name: string;
}

export interface BundledMigrationFile {
  name: string;
  fileName: string;
  path: string;
  hash: string;
  version: MigrationVersion;
}

export function migrationNameFromFileName(fileName: string): string | null {
  const match = /^(\d{4}_.+)\.sql$/.exec(fileName);
  return match?.[1] ?? null;
}

export function parseMigrationVersion(name: string): MigrationVersion | null {
  const match = /^(\d{4})_.+$/.exec(name);
  if (!match) return null;

  return {
    id: Number.parseInt(match[1], 10),
    name,
  };
}

export function compareMigrationVersions(a: MigrationVersion, b: MigrationVersion): number {
  if (a.id !== b.id) return a.id - b.id;
  return a.name.localeCompare(b.name);
}

export function getMigrationsFolder(repoRoot = process.cwd()): string {
  return path.join(repoRoot, "drizzle");
}

export function getBundledMigrationFiles(repoRoot = process.cwd()): BundledMigrationFile[] {
  const migrationsFolder = getMigrationsFolder(repoRoot);
  return fs
    .readdirSync(migrationsFolder)
    .map((fileName) => {
      const name = migrationNameFromFileName(fileName);
      const version = name ? parseMigrationVersion(name) : null;
      if (!name || !version) return null;

      const migrationPath = path.join(migrationsFolder, fileName);
      const contents = fs.readFileSync(migrationPath, "utf8");
      return {
        name,
        fileName,
        path: migrationPath,
        hash: crypto.createHash("sha256").update(contents).digest("hex"),
        version,
      };
    })
    .filter((migration): migration is BundledMigrationFile => migration !== null)
    .sort((a, b) => compareMigrationVersions(a.version, b.version));
}

export function getExpectedLatestMigration(repoRoot = process.cwd()): MigrationVersion {
  const migrationsFolder = getMigrationsFolder(repoRoot);
  const migrations = getBundledMigrationFiles(repoRoot);

  const latest = migrations.at(-1);
  if (!latest) {
    throw new Error(`[schema-version] no migration SQL files found in ${migrationsFolder}`);
  }

  return latest.version;
}
