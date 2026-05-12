import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

beforeEach(async () => {
  await truncateAll(sql);
});

describe("connector_sync_cursors schema", () => {
  it("stores per-install stream cursors and cascades when the install is deleted", async () => {
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('sync-cursor-hive', 'Sync Cursor Hive', 'digital')
      RETURNING id
    `;
    const [install] = await sql<{ id: string }[]>`
      INSERT INTO connector_installs (hive_id, connector_slug, display_name)
      VALUES (${hive.id}, 'discord-webhook', 'Discord')
      RETURNING id
    `;

    const [cursor] = await sql<{ stream: string; cursor: string; last_error: string | null }[]>`
      INSERT INTO connector_sync_cursors (install_id, stream, cursor, last_synced_at)
      VALUES (${install.id}, 'messages', 'cursor-1', NOW())
      RETURNING stream, cursor, last_error
    `;

    expect(cursor).toEqual({ stream: "messages", cursor: "cursor-1", last_error: null });

    await sql`DELETE FROM connector_installs WHERE id = ${install.id}`;
    const [count] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM connector_sync_cursors
    `;
    expect(count.count).toBe(0);
  });
});
