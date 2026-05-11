import "dotenv/config";
import postgres from "postgres";

const DEPRECATED_MODEL = "anthropic/claude-haiku-4-5";
const FAILURE_REASON =
  "Superseded by runtime fallback (Sonnet) — Haiku quality-doctor model deprecated.";

type Candidate = {
  id: string;
  title: string;
  parent_task_id: string | null;
  completed_sibling_ids: string[];
};

const databaseUrl =
  process.env.DATABASE_URL ?? "postgresql://hivewright@localhost:5432/hivewrightv2";
const dryRun = process.argv.includes("--dry-run");

async function main() {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const candidates = await sql<Candidate[]>`
      WITH candidates AS (
        SELECT id, title, brief, parent_task_id
        FROM tasks
        WHERE assigned_to = 'doctor'
          AND status = 'unresolvable'
          AND model_override = ${DEPRECATED_MODEL}
      ),
      matched AS (
        SELECT
          candidate.id,
          candidate.title,
          candidate.parent_task_id,
          ARRAY_AGG(sibling.id ORDER BY sibling.created_at) AS completed_sibling_ids
        FROM candidates candidate
        JOIN tasks sibling
          ON sibling.assigned_to = 'doctor'
         AND sibling.status = 'completed'
         AND sibling.id <> candidate.id
         AND (
           (
             candidate.parent_task_id IS NOT NULL
             AND sibling.parent_task_id = candidate.parent_task_id
           )
           OR (
             sibling.title LIKE '[Doctor retry: claude-code]%'
             AND (
               (
                 candidate.parent_task_id IS NOT NULL
                 AND (
                   sibling.parent_task_id = candidate.parent_task_id
                   OR sibling.title ILIKE '%' || candidate.parent_task_id::text || '%'
                   OR sibling.brief ILIKE '%' || candidate.parent_task_id::text || '%'
                 )
               )
               OR sibling.title ILIKE '%' || candidate.id::text || '%'
               OR sibling.brief ILIKE '%' || candidate.id::text || '%'
             )
           )
         )
        GROUP BY candidate.id, candidate.title, candidate.parent_task_id
      )
      SELECT id, title, parent_task_id, completed_sibling_ids
      FROM matched
      ORDER BY title, id
    `;

    const ids = candidates.map((candidate) => candidate.id);
    if (!dryRun && ids.length > 0) {
      await sql`
        UPDATE tasks
        SET status = 'cancelled',
            failure_reason = ${FAILURE_REASON},
            updated_at = NOW()
        WHERE id = ANY(${ids}::uuid[])
      `;
    }

    console.log(JSON.stringify({
      dryRun,
      deprecatedModel: DEPRECATED_MODEL,
      cancelledCount: dryRun ? 0 : ids.length,
      matchedCount: ids.length,
      cancelledIds: dryRun ? [] : ids,
      matchedIds: ids,
      candidates,
    }, null, 2));
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
