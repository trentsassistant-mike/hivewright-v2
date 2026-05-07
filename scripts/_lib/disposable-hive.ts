import { randomUUID } from "node:crypto";
import type { ParameterOrJSON, Sql, TransactionSql } from "postgres";

const DIRECT_HIVE_DELETE_ORDER = [
  "decision_messages",
  "task_attachments",
  "task_logs",
  "goal_comments",
  "goal_documents",
  "goal_completions",
  "classifications",
  "embedding_reembed_errors",
  "initiative_run_decisions",
  "work_products",
  "classifier_logs",
  "board_sessions",
  "supervisor_reports",
  "push_subscriptions",
  "notification_preferences",
  "standing_instructions",
  "skill_drafts",
  "oauth_states",
  "connector_installs",
  "ea_threads",
  "entity_relationships",
  "role_memory",
  "hive_memory",
  "insights",
  "memory_embeddings",
  "tasks",
  "decisions",
  "initiative_runs",
  "hive_ideas",
  "hive_targets",
  "goals",
  "projects",
  "entities",
  "credentials",
  "adapter_config",
  "schedules",
  "hive_memberships",
] as const;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function toSlugFragment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\[test\]\s*/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "disposable-hive";
}

type QuerySql = Sql | TransactionSql;
type UnsafeParameter = ParameterOrJSON<never>;

async function loadPublicTables(sql: QuerySql): Promise<Set<string>> {
  const rows = await sql<Array<{ tablename: string }>>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  `;
  return new Set(rows.map((row) => row.tablename));
}

async function loadHiveScopedTables(sql: QuerySql): Promise<Set<string>> {
  const rows = await sql<Array<{ tableName: string }>>`
    SELECT table_name AS "tableName"
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'hive_id'
  `;
  return new Set(rows.map((row) => row.tableName));
}

async function deleteIfExists(
  sql: QuerySql,
  knownTables: Set<string>,
  tableName: string,
  statement: string,
  parameters: readonly UnsafeParameter[],
): Promise<void> {
  if (!knownTables.has(tableName)) {
    return;
  }
  await sql.unsafe(statement, [...parameters]);
}

export async function createDisposableHive(sql: Sql, name: string): Promise<string> {
  const displayName = name.startsWith("[TEST] ") ? name : `[TEST] ${name}`;
  const slug = `${toSlugFragment(name)}-${randomUUID().slice(0, 8)}`.slice(0, 63);

  const [hive] = await sql<Array<{ id: string }>>`
    INSERT INTO hives (slug, name, type)
    VALUES (${slug}, ${displayName}, 'digital')
    RETURNING id
  `;

  return hive.id;
}

export async function deleteDisposableHive(sql: Sql, hiveId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const knownTables = await loadPublicTables(tx);
    const hiveScopedTables = await loadHiveScopedTables(tx);

    await deleteIfExists(
      tx,
      knownTables,
      "decision_messages",
      `
        DELETE FROM "decision_messages"
        WHERE decision_id IN (
          SELECT id FROM "decisions" WHERE hive_id = $1
        )
      `,
      [hiveId],
    );

    await deleteIfExists(
      tx,
      knownTables,
      "task_attachments",
      `
        DELETE FROM "task_attachments"
        WHERE task_id IN (
            SELECT id FROM "tasks" WHERE hive_id = $1
          )
          OR goal_id IN (
            SELECT id FROM "goals" WHERE hive_id = $1
          )
          OR idea_id IN (
            SELECT id FROM "hive_ideas" WHERE hive_id = $1
          )
      `,
      [hiveId],
    );

    await deleteIfExists(
      tx,
      knownTables,
      "task_logs",
      `
        DELETE FROM "task_logs"
        WHERE task_id IN (
          SELECT id FROM "tasks" WHERE hive_id = $1
        )
      `,
      [hiveId],
    );

    await deleteIfExists(
      tx,
      knownTables,
      "goal_comments",
      `
        DELETE FROM "goal_comments"
        WHERE goal_id IN (
          SELECT id FROM "goals" WHERE hive_id = $1
        )
      `,
      [hiveId],
    );

    await deleteIfExists(
      tx,
      knownTables,
      "goal_documents",
      `
        DELETE FROM "goal_documents"
        WHERE goal_id IN (
          SELECT id FROM "goals" WHERE hive_id = $1
        )
      `,
      [hiveId],
    );

    await deleteIfExists(
      tx,
      knownTables,
      "goal_completions",
      `
        DELETE FROM "goal_completions"
        WHERE goal_id IN (
          SELECT id FROM "goals" WHERE hive_id = $1
        )
      `,
      [hiveId],
    );

    await deleteIfExists(
      tx,
      knownTables,
      "classifications",
      `
        DELETE FROM "classifications"
        WHERE task_id IN (
            SELECT id FROM "tasks" WHERE hive_id = $1
          )
          OR goal_id IN (
            SELECT id FROM "goals" WHERE hive_id = $1
          )
      `,
      [hiveId],
    );

    await deleteIfExists(
      tx,
      knownTables,
      "embedding_reembed_errors",
      `
        DELETE FROM "embedding_reembed_errors"
        WHERE memory_embedding_id IN (
          SELECT id FROM "memory_embeddings" WHERE hive_id = $1
        )
      `,
      [hiveId],
    );

    const orderedHiveTables = [...hiveScopedTables]
      .filter((tableName) => tableName !== "hives")
      .sort((left, right) => {
        const leftIndex = DIRECT_HIVE_DELETE_ORDER.indexOf(left as (typeof DIRECT_HIVE_DELETE_ORDER)[number]);
        const rightIndex = DIRECT_HIVE_DELETE_ORDER.indexOf(right as (typeof DIRECT_HIVE_DELETE_ORDER)[number]);
        const normalizedLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
        const normalizedRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
        if (normalizedLeft !== normalizedRight) {
          return normalizedLeft - normalizedRight;
        }
        return left.localeCompare(right);
      });

    for (const tableName of orderedHiveTables) {
      await tx.unsafe(
        `DELETE FROM ${quoteIdentifier(tableName)} WHERE hive_id = $1`,
        [hiveId],
      );
    }

    await tx`DELETE FROM hives WHERE id = ${hiveId}`;
  });
}

export async function withDisposableHive<T>(
  sql: Sql,
  name: string,
  fn: (hiveId: string) => Promise<T>,
): Promise<T> {
  const hiveId = await createDisposableHive(sql, name);

  let result: T | undefined;
  let callbackError: unknown;

  try {
    result = await fn(hiveId);
  } catch (error) {
    callbackError = error;
  }

  try {
    await deleteDisposableHive(sql, hiveId);
  } catch (cleanupError) {
    if (callbackError) {
      throw new AggregateError(
        [callbackError, cleanupError],
        `failed to clean up disposable hive ${hiveId}`,
      );
    }
    throw cleanupError;
  }

  if (callbackError) {
    throw callbackError;
  }

  return result as T;
}
