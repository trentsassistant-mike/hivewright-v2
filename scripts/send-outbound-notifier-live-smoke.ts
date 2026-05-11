import "dotenv/config";
import postgres from "postgres";
import { sendDiscordChannelMessage } from "../src/dispatcher/notifier";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://hivewright@localhost:5432/hivewrightv2";

async function main() {
  if (process.env.NOTIFIER_LIVE_SMOKE !== "1") {
    console.log("Skipping live notifier smoke. Set NOTIFIER_LIVE_SMOKE=1 to send one Discord message.");
    return;
  }

  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const requestedHiveId = process.env.NOTIFIER_LIVE_SMOKE_HIVE_ID;
    const [install] = await sql<{ hive_id: string; channel_id: string | null }[]>`
      SELECT hive_id, config->>'channelId' AS channel_id
      FROM connector_installs
      WHERE connector_slug = 'ea-discord'
        AND status = 'active'
        ${requestedHiveId ? sql`AND hive_id = ${requestedHiveId}::uuid` : sql``}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (!install) {
      throw new Error("No active ea-discord connector install found for live smoke.");
    }

    const channelId = process.env.NOTIFIER_LIVE_SMOKE_CHANNEL_ID ?? install.channel_id;
    if (!channelId) throw new Error("No channel id available for live smoke.");

    const result = await sendDiscordChannelMessage(sql, {
      hiveId: install.hive_id,
      channelId,
      content: `HiveWright notifier live smoke: ${new Date().toISOString()}`,
    });
    if (!result.ok) throw new Error(result.error ?? "Discord send failed");
    console.log(JSON.stringify({ ok: true, hiveId: install.hive_id, channelId }, null, 2));
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
