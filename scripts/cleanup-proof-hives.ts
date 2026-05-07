import "dotenv/config";

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const KEEP_HIVE_ID = "b6b815ba-5109-4066-8a33-cc5560d3a0e1";
const EXACT_NAME_MATCHES = [
  "Owner Session Smoke",
  "Empty Initiatives Proof",
  "Initiative Auth Proof",
  "Initiative Direct Proof",
  "Initiative Hardening Proof",
  "Initiative Linkage Verification",
  "Initiative Rollout Verification",
  "Initiative Sprint 2 Proof",
];

type HiveRow = {
  id: string;
  name: string;
};

type TableColumnRow = {
  table_name: string;
  column_name: string;
};

type ForeignKeyRow = {
  child_table: string;
  child_column: string;
  parent_table: string;
  parent_column: string;
};

type CountRow = {
  count: string;
};

type KeeperSnapshot = {
  hiveExists: number;
  goals: number;
  tasks: number;
  ideas: number;
};

type TableSummary = {
  table: string;
  count: number;
};

type HiveSummary = {
  hive: HiveRow;
  tables: TableSummary[];
};

type RunSummary = {
  repoPath: string;
  branch: string;
  head: string;
  keepHiveId: string;
  targetHives: HiveRow[];
  deletionOrder: string[];
  dryRunByHive: HiveSummary[];
  dryRunTotals: TableSummary[];
  before: {
    totalHives: number;
    keeper: KeeperSnapshot;
  };
  after: null | {
    totalHives: number;
    keeper: KeeperSnapshot;
  };
  removed: null | TableSummary[];
  confirmed: boolean;
};

type PathEdge = {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
};

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function parseArgs(args: string[]): { reportPath: string | null } {
  let reportPath: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--report") {
      reportPath = args[index + 1] ?? null;
      index += 1;
    }
  }

  return { reportPath };
}

function getGitValue(args: string[]): string {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
}

function formatTableSummaries(tables: TableSummary[]): string {
  if (tables.length === 0) {
    return "none";
  }
  return tables.map((entry) => `${entry.table}=${entry.count}`).join(", ");
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|");
}

function buildExistsClause(path: PathEdge[], pathIndex: number): string {
  const aliases = path.map((_, index) => `p${pathIndex}_${index + 1}`);
  const firstEdge = path[0];
  const firstAlias = aliases[0];
  const joins: string[] = [];

  for (let index = 1; index < path.length; index += 1) {
    const previousAlias = aliases[index - 1];
    const edge = path[index];
    const currentAlias = aliases[index];
    joins.push(
      `JOIN ${quoteIdent(edge.parentTable)} ${currentAlias} ON ${previousAlias}.${quoteIdent(edge.childColumn)} = ${currentAlias}.${quoteIdent(edge.parentColumn)}`,
    );
  }

  const rootAlias = aliases[aliases.length - 1];
  return [
    "EXISTS (",
    `SELECT 1 FROM ${quoteIdent(firstEdge.parentTable)} ${firstAlias}`,
    joins.join(" "),
    `WHERE t0.${quoteIdent(firstEdge.childColumn)} = ${firstAlias}.${quoteIdent(firstEdge.parentColumn)}`,
    `AND ${rootAlias}.${quoteIdent("hive_id")} = ANY($1::uuid[])`,
    ")",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildPredicate(
  table: string,
  hiveIdTables: Set<string>,
  pathCache: Map<string, PathEdge[][]>,
): string {
  if (table === "hives") {
    return `t0.${quoteIdent("id")} = ANY($1::uuid[])`;
  }

  if (hiveIdTables.has(table)) {
    return `t0.${quoteIdent("hive_id")} = ANY($1::uuid[])`;
  }

  const paths = pathCache.get(table) ?? [];
  if (paths.length === 0) {
    throw new Error(`[cleanup-proof-hives] no hive path found for table '${table}'`);
  }

  return paths.map((path, index) => buildExistsClause(path, index)).join(" OR ");
}

function topologicalSort(nodes: string[], edges: ForeignKeyRow[]): string[] {
  const nodeSet = new Set(nodes);
  const indegree = new Map<string, number>();
  const adjacency = new Map<string, Set<string>>();

  for (const node of nodes) {
    indegree.set(node, 0);
    adjacency.set(node, new Set());
  }

  for (const edge of edges) {
    if (!nodeSet.has(edge.child_table) || !nodeSet.has(edge.parent_table)) {
      continue;
    }
    if (edge.child_table === edge.parent_table) {
      continue;
    }
    if (adjacency.get(edge.child_table)?.has(edge.parent_table)) {
      continue;
    }
    adjacency.get(edge.child_table)?.add(edge.parent_table);
    indegree.set(edge.parent_table, (indegree.get(edge.parent_table) ?? 0) + 1);
  }

  const ready = nodes
    .filter((node) => (indegree.get(node) ?? 0) === 0)
    .sort((left, right) => left.localeCompare(right));
  const ordered: string[] = [];

  while (ready.length > 0) {
    const next = ready.shift();
    if (!next) {
      break;
    }
    ordered.push(next);
    const parents = [...(adjacency.get(next) ?? [])].sort((left, right) =>
      left.localeCompare(right),
    );
    for (const parent of parents) {
      indegree.set(parent, (indegree.get(parent) ?? 0) - 1);
      if ((indegree.get(parent) ?? 0) === 0) {
        ready.push(parent);
        ready.sort((left, right) => left.localeCompare(right));
      }
    }
  }

  if (ordered.length !== nodes.length) {
    throw new Error(
      `[cleanup-proof-hives] unable to compute deletion order; cycle detected in ${nodes.join(", ")}`,
    );
  }

  return ordered;
}

async function countRows(
  sql: postgres.Sql,
  table: string,
  predicate: string,
  targetHiveIds: string[],
): Promise<number> {
  const query = `SELECT COUNT(*)::bigint AS count FROM ${quoteIdent(table)} t0 WHERE ${predicate}`;
  const rows = await sql.unsafe<CountRow[]>(query, [targetHiveIds]);
  return Number(rows[0]?.count ?? 0);
}

async function deleteRows(
  sql: postgres.TransactionSql,
  table: string,
  predicate: string,
  targetHiveIds: string[],
): Promise<number> {
  const query = `
    WITH deleted AS (
      DELETE FROM ${quoteIdent(table)} AS t0
      WHERE ${predicate}
      RETURNING 1
    )
    SELECT COUNT(*)::bigint AS count FROM deleted
  `;
  const rows = await sql.unsafe<CountRow[]>(query, [targetHiveIds]);
  return Number(rows[0]?.count ?? 0);
}

async function loadKeeperSnapshot(sql: postgres.Sql): Promise<KeeperSnapshot> {
  const [hiveExistsRows, goalsRows, tasksRows, ideasRows] = await Promise.all([
    sql.unsafe<CountRow[]>(
      `SELECT COUNT(*)::bigint AS count FROM hives WHERE id = $1::uuid`,
      [KEEP_HIVE_ID],
    ),
    sql.unsafe<CountRow[]>(
      `SELECT COUNT(*)::bigint AS count FROM goals WHERE hive_id = $1::uuid`,
      [KEEP_HIVE_ID],
    ),
    sql.unsafe<CountRow[]>(
      `SELECT COUNT(*)::bigint AS count FROM tasks WHERE hive_id = $1::uuid`,
      [KEEP_HIVE_ID],
    ),
    sql.unsafe<CountRow[]>(
      `SELECT COUNT(*)::bigint AS count FROM hive_ideas WHERE hive_id = $1::uuid`,
      [KEEP_HIVE_ID],
    ),
  ]);

  return {
    hiveExists: Number(hiveExistsRows[0]?.count ?? 0),
    goals: Number(goalsRows[0]?.count ?? 0),
    tasks: Number(tasksRows[0]?.count ?? 0),
    ideas: Number(ideasRows[0]?.count ?? 0),
  };
}

async function loadTotalHives(sql: postgres.Sql): Promise<number> {
  const rows = await sql.unsafe<CountRow[]>(`SELECT COUNT(*)::bigint AS count FROM hives`);
  return Number(rows[0]?.count ?? 0);
}

async function writeReport(reportPath: string, summary: RunSummary): Promise<void> {
  const absolutePath = path.resolve(process.cwd(), reportPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });

  const dryRunLines = summary.dryRunByHive
    .map(
      ({ hive, tables }) =>
        `| ${escapeMarkdown(hive.id)} | ${escapeMarkdown(hive.name)} | ${escapeMarkdown(formatTableSummaries(tables))} |`,
    )
    .join("\n");

  const removedLines = (summary.removed ?? summary.dryRunTotals)
    .map((entry) => `| ${escapeMarkdown(entry.table)} | ${entry.count} |`)
    .join("\n");

  const markdown = `# Proof Hive Cleanup Report

- Repo path: \`${summary.repoPath}\`
- Branch: \`${summary.branch}\`
- HEAD: \`${summary.head}\`
- Keep hive: \`${summary.keepHiveId}\`
- Mode: ${summary.confirmed ? "confirmed delete" : "dry run"}

## Matched Hives

| Hive ID | Name | Matching row counts |
| --- | --- | --- |
${dryRunLines || "| none | none | none |"}

## Deletion Order

\`${summary.deletionOrder.join(" -> ")}\`

## Before Snapshot

- Total hives: ${summary.before.totalHives}
- HiveWright keeper counts: goals=${summary.before.keeper.goals}, tasks=${summary.before.keeper.tasks}, ideas=${summary.before.keeper.ideas}, hive_row=${summary.before.keeper.hiveExists}

## After Snapshot

- Total hives: ${summary.after?.totalHives ?? "not executed"}
- HiveWright keeper counts: ${
    summary.after
      ? `goals=${summary.after.keeper.goals}, tasks=${summary.after.keeper.tasks}, ideas=${summary.after.keeper.ideas}, hive_row=${summary.after.keeper.hiveExists}`
      : "not executed"
  }

## Rows Removed By Table

| Table | Rows |
| --- | ---: |
${removedLines || "| none | 0 |"}

## Verification Commands

\`\`\`bash
npx tsx scripts/cleanup-proof-hives.ts --report ${reportPath}
CONFIRM_DELETE=1 npx tsx scripts/cleanup-proof-hives.ts --report ${reportPath}
psql "$DATABASE_URL" -P pager=off -c "select count(*) as hives_remaining from hives;"
psql "$DATABASE_URL" -P pager=off -c "select id, name from hives order by name;"
\`\`\`
`;

  await writeFile(absolutePath, markdown);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("[cleanup-proof-hives] DATABASE_URL is required");
  }

  const { reportPath } = parseArgs(process.argv.slice(2));
  const confirmed = process.env.CONFIRM_DELETE === "1";
  const sql = postgres(process.env.DATABASE_URL, { max: 1 });

  try {
    const repoPath = getGitValue(["rev-parse", "--show-toplevel"]);
    const branch = getGitValue(["branch", "--show-current"]);
    const head = getGitValue(["rev-parse", "HEAD"]);

    const targetHives = await sql.unsafe<HiveRow[]>(
      `
        SELECT id, name
        FROM hives
        WHERE id <> $1::uuid
          AND (
            name LIKE 'Initiative %'
            OR name = ANY($2::text[])
          )
        ORDER BY name, id
      `,
      [KEEP_HIVE_ID, EXACT_NAME_MATCHES],
    );

    if (targetHives.some((row) => row.id === KEEP_HIVE_ID)) {
      throw new Error("[cleanup-proof-hives] safety abort: keep hive matched deletion filter");
    }
    if (targetHives.length === 0) {
      throw new Error("[cleanup-proof-hives] no disposable proof hives matched the filter");
    }

    const targetHiveIds = targetHives.map((row) => row.id);
    const [beforeTotalHives, keeperBefore, hiveIdColumns, foreignKeys, publicTables] =
      await Promise.all([
        loadTotalHives(sql),
        loadKeeperSnapshot(sql),
        sql.unsafe<TableColumnRow[]>(
          `
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND column_name = 'hive_id'
            ORDER BY table_name
          `,
        ),
        sql.unsafe<ForeignKeyRow[]>(
          `
            SELECT
              tc.table_name AS child_table,
              kcu.column_name AS child_column,
              ccu.table_name AS parent_table,
              ccu.column_name AS parent_column
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name
             AND ccu.table_schema = tc.table_schema
            WHERE tc.table_schema = 'public'
              AND tc.constraint_type = 'FOREIGN KEY'
            ORDER BY child_table, parent_table, child_column
          `,
        ),
        sql.unsafe<{ table_name: string }[]>(
          `
            SELECT tablename AS table_name
            FROM pg_tables
            WHERE schemaname = 'public'
            ORDER BY tablename
          `,
        ),
      ]);

    if (keeperBefore.hiveExists !== 1) {
      throw new Error(
        `[cleanup-proof-hives] expected keep hive to exist exactly once before deletion, found ${keeperBefore.hiveExists}`,
      );
    }

    const hiveIdTables = new Set(hiveIdColumns.map((row) => row.table_name));
    const parentLookup = new Map<string, ForeignKeyRow[]>();

    for (const fk of foreignKeys) {
      const list = parentLookup.get(fk.child_table) ?? [];
      list.push(fk);
      parentLookup.set(fk.child_table, list);
    }

    const pathCache = new Map<string, PathEdge[][]>();

    function findPaths(table: string, stack = new Set<string>()): PathEdge[][] {
      if (pathCache.has(table)) {
        return pathCache.get(table) ?? [];
      }

      if (hiveIdTables.has(table)) {
        pathCache.set(table, []);
        return [];
      }

      if (stack.has(table)) {
        return [];
      }

      stack.add(table);
      const paths: PathEdge[][] = [];
      const foreignKeysForTable = parentLookup.get(table) ?? [];

      for (const fk of foreignKeysForTable) {
        if (hiveIdTables.has(fk.parent_table)) {
          paths.push([
            {
              childTable: fk.child_table,
              childColumn: fk.child_column,
              parentTable: fk.parent_table,
              parentColumn: fk.parent_column,
            },
          ]);
          continue;
        }

        const parentPaths = findPaths(fk.parent_table, stack);
        for (const parentPath of parentPaths) {
          paths.push([
            {
              childTable: fk.child_table,
              childColumn: fk.child_column,
              parentTable: fk.parent_table,
              parentColumn: fk.parent_column,
            },
            ...parentPath,
          ]);
        }
      }

      stack.delete(table);
      const deduped = new Map<string, PathEdge[]>();
      for (const currentPath of paths) {
        const key = currentPath
          .map(
            (edge) =>
              `${edge.childTable}.${edge.childColumn}->${edge.parentTable}.${edge.parentColumn}`,
          )
          .join("|");
        deduped.set(key, currentPath);
      }
      const result = [...deduped.values()];
      pathCache.set(table, result);
      return result;
    }

    const relevantTables = new Set<string>(["hives"]);
    for (const { table_name: tableName } of publicTables) {
      if (tableName === "hives") {
        continue;
      }
      if (hiveIdTables.has(tableName)) {
        relevantTables.add(tableName);
        continue;
      }
      const paths = findPaths(tableName);
      if (paths.length > 0) {
        relevantTables.add(tableName);
      }
    }

    const deletionOrder = topologicalSort([...relevantTables], foreignKeys);
    const predicates = new Map<string, string>();
    for (const table of deletionOrder) {
      predicates.set(table, buildPredicate(table, hiveIdTables, pathCache));
    }

    const dryRunTotals: TableSummary[] = [];
    for (const table of deletionOrder) {
      const count = await countRows(
        sql,
        table,
        predicates.get(table) ?? "",
        targetHiveIds,
      );
      dryRunTotals.push({ table, count });
    }

    const dryRunByHive: HiveSummary[] = [];
    for (const hive of targetHives) {
      const tables: TableSummary[] = [];
      for (const table of deletionOrder) {
        const count = await countRows(sql, table, predicates.get(table) ?? "", [hive.id]);
        if (count > 0) {
          tables.push({ table, count });
        }
      }
      dryRunByHive.push({ hive, tables });
    }

    const summary: RunSummary = {
      repoPath,
      branch,
      head,
      keepHiveId: KEEP_HIVE_ID,
      targetHives,
      deletionOrder,
      dryRunByHive,
      dryRunTotals: dryRunTotals.filter((entry) => entry.count > 0),
      before: {
        totalHives: beforeTotalHives,
        keeper: keeperBefore,
      },
      after: null,
      removed: null,
      confirmed,
    };

    console.log("[cleanup-proof-hives] matched hives:");
    for (const hive of targetHives) {
      console.log(`  - ${hive.id} ${hive.name}`);
    }
    console.log(`[cleanup-proof-hives] deletion order: ${deletionOrder.join(" -> ")}`);
    console.log("[cleanup-proof-hives] dry-run totals:");
    for (const entry of summary.dryRunTotals) {
      console.log(`  - ${entry.table}: ${entry.count}`);
    }
    console.log(
      `[cleanup-proof-hives] keeper snapshot before: goals=${keeperBefore.goals}, tasks=${keeperBefore.tasks}, ideas=${keeperBefore.ideas}, hive_row=${keeperBefore.hiveExists}`,
    );

    if (!confirmed) {
      console.log(
        "[cleanup-proof-hives] dry run only; set CONFIRM_DELETE=1 to execute the transaction",
      );
      if (reportPath) {
        await writeReport(reportPath, summary);
        console.log(
          `[cleanup-proof-hives] wrote dry-run report to ${path.resolve(process.cwd(), reportPath)}`,
        );
      }
      return;
    }

    const removedEntries = await sql.begin(async (tx) => {
      const removed: TableSummary[] = [];
      for (const table of deletionOrder) {
        const count = await deleteRows(
          tx,
          table,
          predicates.get(table) ?? "",
          targetHiveIds,
        );
        removed.push({ table, count });
      }
      return removed;
    });

    const afterTotalHives = await loadTotalHives(sql);
    const keeperAfter = await loadKeeperSnapshot(sql);

    if (afterTotalHives !== 1) {
      throw new Error(
        `[cleanup-proof-hives] expected exactly 1 hive after deletion, found ${afterTotalHives}`,
      );
    }

    if (
      keeperAfter.hiveExists !== keeperBefore.hiveExists ||
      keeperAfter.goals !== keeperBefore.goals ||
      keeperAfter.tasks !== keeperBefore.tasks ||
      keeperAfter.ideas !== keeperBefore.ideas
    ) {
      throw new Error(
        `[cleanup-proof-hives] keeper hive counts changed: before=${JSON.stringify(
          keeperBefore,
        )} after=${JSON.stringify(keeperAfter)}`,
      );
    }

    summary.after = {
      totalHives: afterTotalHives,
      keeper: keeperAfter,
    };
    summary.removed = removedEntries.filter((entry) => entry.count > 0);

    console.log("[cleanup-proof-hives] deletion complete");
    console.log(`[cleanup-proof-hives] total hives after: ${afterTotalHives}`);
    for (const entry of summary.removed) {
      console.log(`  - removed ${entry.count} rows from ${entry.table}`);
    }

    if (reportPath) {
      await writeReport(reportPath, summary);
      console.log(`[cleanup-proof-hives] wrote report to ${path.resolve(process.cwd(), reportPath)}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error("[cleanup-proof-hives] failed:", error);
  process.exit(1);
});
