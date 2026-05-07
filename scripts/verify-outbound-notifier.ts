import "dotenv/config";
import postgres, { type Sql } from "postgres";
import { OutboundNotifier } from "../src/dispatcher/notifier";
import { requireEnv } from "../src/lib/required-env";

const DATABASE_URL = requireEnv("DATABASE_URL");
const HIVE_ID = "00000000-0000-4000-8000-000000007171";
const DECISION_ID = "00000000-0000-4000-8000-000000007172";
const ACHIEVED_GOAL_ID = "00000000-0000-4000-8000-000000007173";
const FAILED_GOAL_IDS = [
  "00000000-0000-4000-8000-000000007174",
  "00000000-0000-4000-8000-000000007175",
  "00000000-0000-4000-8000-000000007176",
];
const SOURCE_IDS = [DECISION_ID, ACHIEVED_GOAL_ID, ...FAILED_GOAL_IDS];
const DEFAULT_DECISION_CHANNEL_ID = "1487611062928019600";
const ACHIEVED_CHANNEL_ID = process.env.NOTIFIER_GOAL_ACHIEVED_CHANNEL_ID ?? "1487611062928019618";
const FAILED_CHANNEL_ID = process.env.NOTIFIER_GOAL_FAILED_CHANNEL_ID ?? "1487611062953050204";

async function main() {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await cleanup(sql);
    await sql`
      INSERT INTO hives (id, slug, name, type)
      VALUES (${HIVE_ID}::uuid, 'notifier-fixture', 'Notifier Fixture', 'digital')
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO decisions (id, hive_id, title, context, recommendation, status, priority)
      VALUES (
        ${DECISION_ID}::uuid,
        ${HIVE_ID}::uuid,
        'Notifier fixture decision',
        'The owner needs to pick the next business action.',
        'Choose the lowest-risk action.',
        'pending',
        'normal'
      )
    `;
    await sql`
      INSERT INTO goals (id, hive_id, title, description, status, updated_at)
      VALUES
        (${ACHIEVED_GOAL_ID}::uuid, ${HIVE_ID}::uuid, 'Notifier achieved fixture', 'Fixture achieved.', 'achieved', NOW()),
        (${FAILED_GOAL_IDS[0]}::uuid, ${HIVE_ID}::uuid, 'Notifier failed fixture 1', 'Fixture failed.', 'failed', NOW()),
        (${FAILED_GOAL_IDS[1]}::uuid, ${HIVE_ID}::uuid, 'Notifier failed fixture 2', 'Fixture failed again.', 'failed', NOW()),
        (${FAILED_GOAL_IDS[2]}::uuid, ${HIVE_ID}::uuid, 'Notifier abandoned fixture', 'Fixture abandoned.', 'abandoned', NOW())
    `;

    const notifier = new OutboundNotifier(sql, {
      throttleMs: 100,
      dryRun: true,
      decisionChannelId: process.env.NOTIFIER_DECISION_CHANNEL_ID ?? DEFAULT_DECISION_CHANNEL_ID,
      achievedChannelId: ACHIEVED_CHANNEL_ID,
      failedChannelId: FAILED_CHANNEL_ID,
      lookbackHours: 24,
    });

    await notifier.scanAndQueue();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await notifier.flushAll();

    const firstPass = await sql<{ status: string; channel_id: string; source_id: string; content: string | null }[]>`
      SELECT status, channel_id, source_id, payload->>'content' AS content
      FROM outbound_notifications
      WHERE source_id IN ${sql(SOURCE_IDS)}
      ORDER BY source_id
    `;

    const failedBucketPayloads = await sql<{ channel_id: string; content: string; source_count: string }[]>`
      SELECT channel_id, payload->>'content' AS content, COUNT(*)::text AS source_count
      FROM outbound_notifications
      WHERE source_id IN ${sql(FAILED_GOAL_IDS)}
      GROUP BY channel_id, payload->>'content'
    `;

    await notifier.scanAndQueue();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await notifier.flushAll();

    const secondPassCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM outbound_notifications
      WHERE source_id IN ${sql(SOURCE_IDS)}
    `;

    const ok =
      firstPass.length === SOURCE_IDS.length &&
      firstPass.every((row) => row.status === "dry_run") &&
      firstPass.some((row) => row.channel_id === DEFAULT_DECISION_CHANNEL_ID || row.channel_id === process.env.NOTIFIER_DECISION_CHANNEL_ID) &&
      firstPass.some((row) => row.channel_id === ACHIEVED_CHANNEL_ID) &&
      firstPass.some((row) => row.channel_id === FAILED_CHANNEL_ID) &&
      failedBucketPayloads.length === 1 &&
      failedBucketPayloads[0]?.channel_id === FAILED_CHANNEL_ID &&
      failedBucketPayloads[0]?.source_count === String(FAILED_GOAL_IDS.length) &&
      failedBucketPayloads[0]?.content.includes(`${FAILED_GOAL_IDS.length} HiveWright updates`) &&
      secondPassCount[0]?.count === String(SOURCE_IDS.length);

    console.log(JSON.stringify({
      ok,
      firstPass,
      failedBucketPayloads,
      notificationRowsAfterReplay: Number(secondPassCount[0]?.count ?? 0),
    }, null, 2));

    if (!ok) process.exitCode = 1;
  } finally {
    await cleanup(sql);
    await sql.end();
  }
}

async function cleanup(sql: Sql) {
  await sql`
    DELETE FROM outbound_notifications
    WHERE source_id IN ${sql(SOURCE_IDS)}
  `;
  await sql`DELETE FROM decisions WHERE id = ${DECISION_ID}::uuid`;
  await sql`DELETE FROM goals WHERE id IN ${sql([ACHIEVED_GOAL_ID, ...FAILED_GOAL_IDS])}`;
  await sql`DELETE FROM hives WHERE id = ${HIVE_ID}::uuid`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
