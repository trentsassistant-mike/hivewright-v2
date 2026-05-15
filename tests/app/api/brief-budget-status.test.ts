import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/brief/route";
import { testSql as sql, truncateAll } from "../../_lib/test-db";

const HIVE = "aaaaaaaa-0000-0000-0000-000000000111";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE}, 'brief-budget-hive', 'Brief Budget Hive', 'digital')
  `;
});

describe("GET /api/brief budget status", () => {
  it("returns recorded warning budget state for goals in the owner brief", async () => {
    await sql`
      INSERT INTO goals (
        hive_id,
        title,
        status,
        budget_cents,
        spent_cents,
        budget_state,
        budget_warning_triggered_at
      )
      VALUES (
        ${HIVE},
        'warning-goal',
        'active',
        1000,
        850,
        'warning',
        NOW()
      )
    `;

    const res = await GET(new Request(`http://localhost/api/brief?hiveId=${HIVE}`));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.goals).toEqual([
      expect.objectContaining({
        title: "warning-goal",
        budget: expect.objectContaining({
          capCents: 1000,
          spentCents: 850,
          remainingCents: 150,
          percentUsed: 85,
          warning: true,
          paused: false,
          state: "warning",
        }),
      }),
    ]);
  });
});
