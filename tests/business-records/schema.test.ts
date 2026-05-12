import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

beforeEach(async () => {
  await truncateAll(sql);
});

describe("business_records schema", () => {
  it("stores generic normalized records with a unique source key", async () => {
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('business-records-hive', 'Business Records Hive', 'digital')
      RETURNING id
    `;

    await sql`
      INSERT INTO business_records (
        hive_id, source_connector, external_id, record_type, title, normalized, raw_redacted
      )
      VALUES (
        ${hive.id}, 'stripe', 'ch_1', 'charge', 'Charge 1',
        ${sql.json({ amount: 100 })}, ${sql.json({ id: 'ch_1' })}
      )
    `;

    await expect(sql`
      INSERT INTO business_records (hive_id, source_connector, external_id, record_type)
      VALUES (${hive.id}, 'stripe', 'ch_1', 'charge')
    `).rejects.toThrow();
  });
});
