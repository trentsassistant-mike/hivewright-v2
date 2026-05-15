import postgres from "postgres";

type Args = {
  decisionId: string;
  replacementLimit: number;
  taskFamilyRootId?: string;
  note?: string;
  dryRun: boolean;
};

function usage(): never {
  throw new Error(
    "Usage: tsx scripts/set-recovery-budget-override.ts --decision-id <uuid> --replacement-limit <int> " +
      "[--task-family-root-id <uuid>] [--note <text>] [--dry-run]",
  );
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    decisionId: "",
    replacementLimit: 0,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--decision-id") {
      args.decisionId = argv[++i] ?? "";
    } else if (arg === "--replacement-limit") {
      args.replacementLimit = Number(argv[++i] ?? "");
    } else if (arg === "--task-family-root-id") {
      args.taskFamilyRootId = argv[++i] ?? "";
    } else if (arg === "--note") {
      args.note = argv[++i] ?? "";
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else {
      usage();
    }
  }

  if (!args.decisionId || !Number.isInteger(args.replacementLimit) || args.replacementLimit <= 0) {
    usage();
  }

  return args;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function loadRootTaskId(
  sql: ReturnType<typeof postgres>,
  taskId: string,
): Promise<string> {
  const [row] = await sql<{ root_task_id: string }[]>`
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_task_id, 0 AS depth
      FROM tasks
      WHERE id = ${taskId}

      UNION ALL

      SELECT parent.id, parent.parent_task_id, ancestors.depth + 1
      FROM tasks parent
      JOIN ancestors ON ancestors.parent_task_id = parent.id
    )
    SELECT id AS root_task_id
    FROM ancestors
    ORDER BY depth DESC
    LIMIT 1
  `;
  if (!row?.root_task_id) {
    throw new Error(`Could not resolve root task for ${taskId}`);
  }
  return row.root_task_id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!isUuidLike(args.decisionId)) {
    throw new Error(`Invalid decision id: ${args.decisionId}`);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [decision] = await sql<{
      id: string;
      status: string;
      task_id: string | null;
      route_metadata: Record<string, unknown> | null;
    }[]>`
      SELECT id, status, task_id, route_metadata
      FROM decisions
      WHERE id = ${args.decisionId}
      LIMIT 1
    `;
    if (!decision) {
      throw new Error(`Decision not found: ${args.decisionId}`);
    }
    if (decision.status !== "resolved") {
      throw new Error(`Decision ${args.decisionId} must be resolved before applying an override`);
    }
    if (!decision.task_id) {
      throw new Error(`Decision ${args.decisionId} is not linked to a task family`);
    }

    const rootTaskId = await loadRootTaskId(sql, decision.task_id);
    if (args.taskFamilyRootId && args.taskFamilyRootId !== rootTaskId) {
      throw new Error(
        `Provided task family root ${args.taskFamilyRootId} does not match resolved root ${rootTaskId}`,
      );
    }

    const override = {
      enabled: true,
      taskFamilyRootId: rootTaskId,
      replacementTasksPerFailureFamily: args.replacementLimit,
      approvedAt: new Date().toISOString(),
      updatedBy: "scripts/set-recovery-budget-override.ts",
      note: args.note ?? null,
    };

    if (args.dryRun) {
      console.log(JSON.stringify({
        decisionId: args.decisionId,
        taskFamilyRootId: rootTaskId,
        override,
      }, null, 2));
      return;
    }

    const [updated] = await sql<{ route_metadata: Record<string, unknown> }[]>`
      UPDATE decisions
      SET route_metadata = COALESCE(route_metadata, '{}'::jsonb) ||
        ${sql.json({ recoveryBudgetOverride: override })}::jsonb
      WHERE id = ${args.decisionId}
      RETURNING route_metadata
    `;

    console.log(JSON.stringify({
      decisionId: args.decisionId,
      taskFamilyRootId: rootTaskId,
      routeMetadata: updated.route_metadata,
    }, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
