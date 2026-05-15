import { beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/brief/route";
import { testSql as sql, truncateAll } from "../../_lib/test-db";

const HIVE = "aaaaaaaa-0000-0000-0000-000000000222";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type, ai_budget_cap_cents, ai_budget_window)
    VALUES (${HIVE}, 'brief-ai-budget-hive', 'Brief AI Budget Hive', 'digital', 10000, 'monthly')
  `;
});

describe("GET /api/brief pilot budget", () => {
  it("returns a workspace-level warning budget surface in USD from recorded spend", async () => {
    await sql`
      INSERT INTO tasks (
        hive_id,
        assigned_to,
        created_by,
        title,
        brief,
        status,
        estimated_billable_cost_cents,
        cost_cents
      )
      VALUES
        (${HIVE}, 'dev-agent', 'owner', 'pilot-budget-estimated', 'A', 'completed', 8200, 9999),
        (${HIVE}, 'dev-agent', 'owner', 'pilot-budget-recorded', 'B', 'completed', NULL, 300)
    `;

    const res = await GET(new Request(`http://localhost/api/brief?hiveId=${HIVE}`));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.aiBudget).toMatchObject({
      currency: "USD",
      capCents: 10_000,
      consumedCents: 8_500,
      remainingCents: 1_500,
      progressPct: 85,
      state: "warning",
      warningThresholdPct: 80,
      breachedThresholdPct: 100,
      enforcement: {
        mode: "creation_pause",
        blocksNewWork: false,
      },
    });
  });
});
