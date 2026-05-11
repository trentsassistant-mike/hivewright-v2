import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveRuntimePath } from "../src/runtime/paths";
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import {
  createDormantGoalProofFixture,
  DORMANT_GOAL_EXCLUDED_LIVE_GOAL_ID,
  DORMANT_GOAL_WORKSTREAM_GOAL_ID,
  inspectDormantGoalProofPreflight,
} from "@/initiative-engine/proof-fixture";

const TEST_DB_NAME_PREFIX = "hivewrightv2_test";
const DEFAULT_TEST_DB_URL = `postgresql://hivewright:placeholder@localhost:5432/${TEST_DB_NAME_PREFIX}`;
const DEFAULT_ADMIN_URL = "postgresql://hivewright:placeholder@localhost:5432/postgres";
const OUT_FLAG = "--out";
const KEEP_DB_FLAG = "--keep-db";
const VERIFY_PROOF_FLAG = "--verify-proof";

function buildRunDbUrl(): { dbName: string; testDbUrl: string } {
  const baseUrl = new URL(process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DB_URL);
  const baseDbName = decodeURIComponent(baseUrl.pathname.replace(/^\//, ""));
  if (!baseDbName.startsWith(TEST_DB_NAME_PREFIX)) {
    throw new Error(
      `[dormant-goal-proof-fixture] base test DB '${baseDbName}' must start with '${TEST_DB_NAME_PREFIX}'`,
    );
  }

  const suffix = `fixture_${Date.now()}_${process.pid}`.replace(/[^a-z0-9_]/g, "_");
  const dbName = `${TEST_DB_NAME_PREFIX}_${suffix}`.slice(0, 63);
  baseUrl.pathname = `/${dbName}`;
  return {
    dbName,
    testDbUrl: baseUrl.toString(),
  };
}

function parseArgs(args: string[]): {
  outputPath: string | null;
  keepDb: boolean;
  verifyProof: boolean;
} {
  let outputPath: string | null = null;
  let keepDb = false;
  let verifyProof = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === OUT_FLAG) {
      outputPath = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (arg === KEEP_DB_FLAG) {
      keepDb = true;
      continue;
    }
    if (arg === VERIFY_PROOF_FLAG) {
      verifyProof = true;
      continue;
    }
  }

  return { outputPath, keepDb, verifyProof };
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env,
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `[dormant-goal-proof-fixture] command failed: ${command} ${args.join(" ")}`,
    );
  }
}

async function dropDatabase(adminUrl: string, dbName: string): Promise<void> {
  const admin = postgres(adminUrl, { max: 1 });
  try {
    await admin`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = ${dbName}
        AND pid <> pg_backend_pid()
    `;
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function main() {
  const { outputPath, keepDb, verifyProof } = parseArgs(process.argv.slice(2));
  const adminUrl = process.env.TEST_ADMIN_URL ?? DEFAULT_ADMIN_URL;
  const { dbName, testDbUrl } = buildRunDbUrl();
  const env = {
    ...process.env,
    TEST_DATABASE_URL: testDbUrl,
    DATABASE_URL: testDbUrl,
    TEST_ADMIN_URL: adminUrl,
  };

  let sql: postgres.Sql | null = null;

  try {
    console.log(`[dormant-goal-proof-fixture] isolated test DB: ${dbName}`);
    runCommand("npx", ["tsx", "scripts/setup-test-db.ts"], env);

    sql = postgres(testDbUrl, { max: 1 });
    const fixture = await createDormantGoalProofFixture(sql);
    const preflight = await inspectDormantGoalProofPreflight(sql, fixture);

    if (!preflight.ready) {
      throw new Error(
        `[dormant-goal-proof-fixture] preflight failed: ${preflight.failures.join("; ")}`,
      );
    }

    const resolvedOutputPath =
      outputPath ??
      resolveRuntimePath([
        "artifacts",
        `dormant-goal-proof-fixture-${new Date().toISOString().slice(0, 10)}.json`,
      ]);
    const absoluteOutputPath = path.resolve(process.cwd(), resolvedOutputPath);
    await mkdir(path.dirname(absoluteOutputPath), { recursive: true });

    const proofOutputPath = absoluteOutputPath.replace(/\.json$/i, ".proof.json");
    const payload = {
      command: `npm run initiative:dormant-goal:fixture -- ${verifyProof ? "--verify-proof " : ""}--out ${resolvedOutputPath}`.trim(),
      databaseName: dbName,
      databaseUrl: keepDb ? testDbUrl : null,
      fixture,
      preflight,
      nextProofCommand: keepDb
        ? `DATABASE_URL='${testDbUrl}' npm run initiative:run-once -- ${fixture.hiveId} --out ${proofOutputPath}`
        : null,
      scope: {
        workstreamGoalId: DORMANT_GOAL_WORKSTREAM_GOAL_ID,
        excludedLiveGoalId: DORMANT_GOAL_EXCLUDED_LIVE_GOAL_ID,
        note: "The suppression-control fixture goal is separate from achieved live goal a2030e88.",
      },
      verification: null as null | {
        command: string;
      },
    };

    if (verifyProof) {
      const relativeProofPath = path.relative(process.cwd(), proofOutputPath);
      runCommand(
        "npx",
        ["tsx", "scripts/run-initiative-schedule.ts", fixture.hiveId, "--out", relativeProofPath],
        env,
      );
      payload.verification = {
        command: `DATABASE_URL='${testDbUrl}' npm run initiative:run-once -- ${fixture.hiveId} --out ${relativeProofPath}`,
      };
    }

    await writeFile(absoluteOutputPath, JSON.stringify(payload, null, 2));

    console.log(`[dormant-goal-proof-fixture] workstream goal: ${DORMANT_GOAL_WORKSTREAM_GOAL_ID}`);
    console.log(`[dormant-goal-proof-fixture] excluded live goal: ${DORMANT_GOAL_EXCLUDED_LIVE_GOAL_ID}`);
    console.log(`[dormant-goal-proof-fixture] fixture hive: ${fixture.hiveId}`);
    console.log(`[dormant-goal-proof-fixture] schedule: ${fixture.scheduleId}`);
    console.log(`[dormant-goal-proof-fixture] primary fixture goal: ${fixture.primaryGoalId}`);
    console.log(
      `[dormant-goal-proof-fixture] suppression-control fixture goal: ${fixture.suppressionControlGoalId}`,
    );
    console.log(`[dormant-goal-proof-fixture] preflight: PASS`);
    console.log(`[dormant-goal-proof-fixture] output: ${absoluteOutputPath}`);
    console.log(
      keepDb
        ? `[dormant-goal-proof-fixture] next proof command: DATABASE_URL='${testDbUrl}' npm run initiative:run-once -- ${fixture.hiveId} --out ${proofOutputPath}`
        : "[dormant-goal-proof-fixture] temp DB will be dropped; use --keep-db for a follow-up proof command or --verify-proof to run proof immediately.",
    );
  } finally {
    if (sql) {
      await sql.end({ timeout: 5 });
    }
    if (!keepDb) {
      await dropDatabase(adminUrl, dbName);
      console.log(`[dormant-goal-proof-fixture] dropped isolated test DB: ${dbName}`);
    }
  }
}

main().catch((error) => {
  console.error("[dormant-goal-proof-fixture] failed:", error);
  process.exit(1);
});
