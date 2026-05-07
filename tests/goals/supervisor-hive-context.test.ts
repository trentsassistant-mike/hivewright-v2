import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { buildSupervisorInitialPrompt } from "../../src/goals/supervisor-session";

describe("buildSupervisorInitialPrompt — hive context injection", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("includes mission + targets for the goal's hive", async () => {
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (name, slug, type, description, mission)
      VALUES ('Sup Hive', 'sup-hive', 'digital', 'desc', 'Ship the MVP by EOY.')
      RETURNING id
    `;
    await sql`
      INSERT INTO hive_targets (hive_id, title, target_value, sort_order)
      VALUES (${hive.id}, 'Launch', 'Q4 2026', 0)
    `;
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, description, status)
      VALUES (${hive.id}, 'Goal A', 'test goal', 'active')
      RETURNING id
    `;

    const prompt = await buildSupervisorInitialPrompt(sql, goal.id);

    expect(prompt).toContain("## Hive Context");
    expect(prompt).toContain("**Mission:**");
    expect(prompt).toContain("Ship the MVP by EOY.");
    expect(prompt).toContain("**Targets:**");
    expect(prompt).toContain("- Launch: Q4 2026");
  });

  it("renders supervisor prompt cleanly when hive has no mission/targets", async () => {
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (name, slug, type, description, mission)
      VALUES ('Bare', 'bare', 'digital', null, null)
      RETURNING id
    `;
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, description, status)
      VALUES (${hive.id}, 'G', 'g', 'active')
      RETURNING id
    `;
    const prompt = await buildSupervisorInitialPrompt(sql, goal.id);
    expect(prompt).toContain("## Hive Context");
    expect(prompt).toContain("**Hive:** Bare");
    expect(prompt).not.toContain("**Mission:**");
  });
});
