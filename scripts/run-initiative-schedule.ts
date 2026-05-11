import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveRuntimePath } from "../src/runtime/paths";
import postgres, { type Sql } from "postgres";
import { submitWorkIntake } from "../src/app/api/work/route";
import { checkAndFireSchedules } from "../src/dispatcher/schedule-timer";
import { withDisposableHive } from "./_lib/disposable-hive";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://hivewright@localhost:5432/hivewrightv2";
const DEMO_FLAG = "--demo";
const OUT_FLAG = "--out";

interface RunDecisionRow {
  id: string;
  run_id: string;
  candidate_ref: string | null;
  action_taken: string;
  suppression_reason: string | null;
  rationale: string;
  created_task_id: string | null;
  dedupe_key: string | null;
  evidence: unknown;
  created_at: Date;
}

interface InitiativeRunPacketRow {
  id: string;
  hive_id: string;
  trigger_type: string;
  trigger_ref: string | null;
  status: string;
  started_at: Date;
  completed_at: Date | null;
  evaluated_candidates: number;
  created_count: number;
  suppressed_count: number;
  noop_count: number;
}

interface InitiativeEvidencePacket {
  command: string;
  hiveId: string;
  scheduleId: string;
  runId: string;
  packetPath: string;
  aggregates: {
    evaluatedCandidates: number;
    createdCount: number;
    suppressedCount: number;
    noopCount: number;
  };
  decisionRows: Array<{
    id: string;
    runId: string;
    candidate_ref: string | null;
    action_taken: string;
    created_task_id: string | null;
    suppression_reason: string | null;
    rationale: string;
    dedupe_key: string | null;
    evidence: unknown;
    created_at: string;
  }>;
}

async function ensureDevAgent(sql: Sql) {
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Dev Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
}

async function ensureSchedule(sql: Sql, hiveId: string): Promise<string> {
  const [existingSchedule] = await sql<Array<{ id: string }>>`
    SELECT id
    FROM schedules
    WHERE hive_id = ${hiveId}
      AND task_template ->> 'kind' = 'initiative-evaluation'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (existingSchedule?.id) return existingSchedule.id;

  return (
    await sql<Array<{ id: string }>>`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${hiveId},
        '0 * * * *',
        ${sql.json({
          kind: "initiative-evaluation",
          assignedTo: "initiative-engine",
          title: "Initiative evaluation",
          brief: "(populated at run time)",
        })},
        true,
        NOW() - interval '1 minute',
        'script:run-initiative-schedule'
      )
      RETURNING id
    `
  )[0].id;
}

async function fireSchedule(sql: Sql, scheduleId: string): Promise<number> {
  await sql`
    UPDATE schedules
    SET next_run_at = NOW() - interval '1 minute'
    WHERE id = ${scheduleId}
  `;
  return checkAndFireSchedules(sql);
}

function installDirectWorkIntakeFetch(sql: Sql): () => void {
  process.env.INTERNAL_SERVICE_TOKEN ??= "script-initiative-token";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: string | URL | globalThis.Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      hiveId: string;
      input: string;
      assignedTo: string;
      projectId?: string | null;
      goalId?: string | null;
      priority: number;
      acceptanceCriteria: string;
    };

    const created = await submitWorkIntake({
      db: sql,
      hiveId: body.hiveId,
      input: body.input,
      assignedTo: body.assignedTo,
      projectId: body.projectId,
      goalId: body.goalId,
      priority: body.priority,
      acceptanceCriteria: body.acceptanceCriteria,
      files: [],
      createdBy: "initiative-engine",
    });

    return new Response(JSON.stringify({ data: created }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function findLatestRunForSchedule(
  sql: Sql,
  hiveId: string,
  scheduleId: string,
): Promise<InitiativeRunPacketRow | null> {
  const [row] = await sql<InitiativeRunPacketRow[]>`
    SELECT id, hive_id, trigger_type, trigger_ref, status, started_at, completed_at,
           evaluated_candidates, created_count, suppressed_count, noop_count
    FROM initiative_runs
    WHERE hive_id = ${hiveId}
      AND trigger_type = 'schedule'
      AND trigger_ref = ${scheduleId}
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `;

  return row ?? null;
}

async function findRunDecisions(
  sql: Sql,
  runId: string,
): Promise<RunDecisionRow[]> {
  return sql<RunDecisionRow[]>`
    SELECT id, run_id, candidate_ref, action_taken, suppression_reason, rationale,
           created_task_id, dedupe_key, evidence, created_at
    FROM initiative_run_decisions
    WHERE run_id = ${runId}
    ORDER BY created_at ASC, id ASC
  `;
}

function parseArgs(args: string[]): { useDemo: boolean; hiveId: string | null; outputPath: string | null } {
  let useDemo = false;
  let hiveId: string | null = null;
  let outputPath: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === DEMO_FLAG) {
      useDemo = true;
      continue;
    }
    if (arg === OUT_FLAG) {
      outputPath = args[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (!hiveId) {
      hiveId = arg;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  return { useDemo, hiveId, outputPath };
}

async function saveEvidencePacket(
  packet: Omit<InitiativeEvidencePacket, "packetPath">,
  explicitPath: string | null,
): Promise<InitiativeEvidencePacket> {
  const packetPath = explicitPath
    ? path.resolve(explicitPath)
    : resolveRuntimePath(["artifacts", "initiative-run-evidence", `${packet.runId}.json`]);

  await mkdir(path.dirname(packetPath), { recursive: true });
  const completedPacket: InitiativeEvidencePacket = { ...packet, packetPath };
  await writeFile(packetPath, `${JSON.stringify(completedPacket, null, 2)}\n`, "utf8");
  return completedPacket;
}

async function main() {
  const sql = postgres(DATABASE_URL, { max: 1 });
  const restoreFetch = installDirectWorkIntakeFetch(sql);
  try {
    const args = parseArgs(process.argv.slice(2));
    const useDemo = args.useDemo;

    let hiveId: string;
    let scheduleId: string;

    const runOnce = async (targetHiveId: string, targetScheduleId: string) => {
      const fired = await fireSchedule(sql, targetScheduleId);
      const run = await findLatestRunForSchedule(sql, targetHiveId, targetScheduleId);
      if (!run) {
        throw new Error(`No initiative run found for hive ${targetHiveId} and schedule ${targetScheduleId}`);
      }

      const decisionRows = await findRunDecisions(sql, run.id);
      const packet = await saveEvidencePacket({
        command: useDemo
          ? "pnpm initiative:run-once --demo"
          : `pnpm initiative:run-once ${targetHiveId}`,
        hiveId: targetHiveId,
        scheduleId: targetScheduleId,
        runId: run.id,
        aggregates: {
          evaluatedCandidates: Number(run.evaluated_candidates ?? 0),
          createdCount: Number(run.created_count ?? 0),
          suppressedCount: Number(run.suppressed_count ?? 0),
          noopCount: Number(run.noop_count ?? 0),
        },
        decisionRows: decisionRows.map((row) => ({
          id: row.id,
          runId: row.run_id,
          candidate_ref: row.candidate_ref,
          action_taken: row.action_taken,
          created_task_id: row.created_task_id,
          suppression_reason: row.suppression_reason,
          rationale: row.rationale,
          dedupe_key: row.dedupe_key,
          evidence: row.evidence,
          created_at: row.created_at.toISOString(),
        })),
      }, args.outputPath);

      return {
        command: packet.command,
        hiveId: packet.hiveId,
        scheduleId: packet.scheduleId,
        runId: packet.runId,
        fired,
        packetPath: packet.packetPath,
        aggregates: packet.aggregates,
        createdDecision: packet.decisionRows.find((row) => row.action_taken === "create_task") ?? null,
        suppressedDecision: packet.decisionRows.find((row) => row.action_taken === "suppress") ?? null,
      };
    };

    const output = useDemo
      ? await withDisposableHive(sql, "Initiative Demo", async (disposableHiveId) => {
          await ensureDevAgent(sql);
          await sql`
            INSERT INTO goals (hive_id, title, description, status, created_at, updated_at)
            VALUES
              (
                ${disposableHiveId},
                'Revive dormant goal',
                'Make forward progress on the dormant work.',
                'active',
                NOW() - interval '5 days',
                NOW() - interval '4 days'
              ),
              (
                ${disposableHiveId},
                'Second dormant goal',
                'Another goal that should be suppressed by the per-run cap.',
                'active',
                NOW() - interval '4 days',
                NOW() - interval '3 days'
              )
          `;

          const [schedule] = await sql<Array<{ id: string }>>`
            INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
            VALUES (
              ${disposableHiveId},
              '0 * * * *',
              ${sql.json({
                kind: "initiative-evaluation",
                assignedTo: "initiative-engine",
                title: "Initiative evaluation",
                brief: "(populated at run time)",
              })},
              true,
              NOW() - interval '1 minute',
              'script:run-initiative-schedule'
            )
            RETURNING id
          `;

          return runOnce(disposableHiveId, schedule.id);
        })
      : await (async () => {
          const providedHiveId = args.hiveId;
          if (!providedHiveId) {
            throw new Error(
              "usage: tsx scripts/run-initiative-schedule.ts <hiveId> [--out <path>] | --demo [--out <path>]",
            );
          }

          hiveId = providedHiveId;
          scheduleId = await ensureSchedule(sql, hiveId);
          return runOnce(hiveId, scheduleId);
        })();

    console.log(JSON.stringify(output, null, 2));
  } finally {
    restoreFetch();
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
