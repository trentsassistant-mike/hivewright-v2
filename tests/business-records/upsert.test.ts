import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { upsertBusinessRecord } from "@/business-records/upsert";

beforeEach(async () => {
  await truncateAll(sql);
});

describe("upsertBusinessRecord", () => {
  it("redacts raw payloads and updates by source key while preserving created_at", async () => {
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('business-upsert-hive', 'Business Upsert Hive', 'digital')
      RETURNING id
    `;

    const first = await upsertBusinessRecord(sql, {
      hiveId: hive.id,
      sourceConnector: "stripe",
      externalId: "ch_1",
      recordType: "charge",
      title: "Original",
      rawPayload: { id: "ch_1", apiKey: "secret" },
      normalized: { amount: 100 },
    });
    const second = await upsertBusinessRecord(sql, {
      hiveId: hive.id,
      sourceConnector: "stripe",
      externalId: "ch_1",
      recordType: "charge",
      title: "Updated",
      rawPayload: { id: "ch_1", token: "secret" },
      normalized: { amount: 200 },
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt.toISOString()).toBe(first.createdAt.toISOString());
    const [row] = await sql<{
      title: string;
      normalized: Record<string, unknown>;
      raw_redacted: Record<string, unknown>;
    }[]>`
      SELECT title, normalized, raw_redacted
      FROM business_records
      WHERE id = ${first.id}
    `;
    expect(row.title).toBe("Updated");
    expect(row.normalized).toEqual({ amount: 200 });
    expect(row.raw_redacted).toEqual({ id: "ch_1", token: "[REDACTED]" });
  });

  it("rejects oversized raw payloads before storage", async () => {
    await expect(upsertBusinessRecord(sql, {
      hiveId: "11111111-1111-4111-8111-111111111111",
      sourceConnector: "stripe",
      externalId: "huge",
      recordType: "charge",
      rawPayload: { body: "x".repeat(220_000) },
    })).rejects.toThrow(/too large/i);
  });
});
