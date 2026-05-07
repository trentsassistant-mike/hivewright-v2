import { describe, it, expect, beforeEach } from "vitest";
import { findEvolutionCandidates, proposeRoleUpdate } from "@/memory/role-evolution";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [biz] = await sql`INSERT INTO hives (slug, name, type) VALUES ('p6-evol-test', 'Evol Test', 'digital') RETURNING *`;
  bizId = biz.id;
  // role_memory has FK on role_templates.slug — seed the role first
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Dev Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("findEvolutionCandidates", () => {
  it("finds high-access memories as evolution candidates", async () => {
    await sql`INSERT INTO role_memory (hive_id, role_slug, content, confidence, access_count)
      VALUES (${bizId}, 'dev-agent', 'p6-evol-Always use cursor pagination', 0.9, 5)`;
    await sql`INSERT INTO role_memory (hive_id, role_slug, content, confidence, access_count)
      VALUES (${bizId}, 'dev-agent', 'p6-evol-Rarely accessed fact', 0.9, 1)`;

    const candidates = await findEvolutionCandidates(sql, bizId);
    expect(candidates.some(c => c.pattern.includes("p6-evol-Always use cursor"))).toBe(true);
    expect(candidates.some(c => c.pattern.includes("p6-evol-Rarely accessed"))).toBe(false);
  });
});

describe("proposeRoleUpdate", () => {
  it("creates a decision for the role update", async () => {
    const decId = await proposeRoleUpdate(sql, {
      roleSlug: "dev-agent",
      hiveId: bizId,
      pattern: "p6-evol-Always use cursor pagination for API responses",
      occurrences: 5,
    });
    expect(decId).toBeTruthy();

    const [dec] = await sql`SELECT * FROM decisions WHERE id = ${decId}`;
    expect(dec.title).toContain("dev-agent");
    expect(dec.context).toContain("p6-evol-Always use cursor");
  });

  it("does not create duplicate decisions", async () => {
    const id1 = await proposeRoleUpdate(sql, { roleSlug: "dev-agent", hiveId: bizId, pattern: "p6-evol-dup test", occurrences: 3 });
    const id2 = await proposeRoleUpdate(sql, { roleSlug: "dev-agent", hiveId: bizId, pattern: "p6-evol-dup test2", occurrences: 4 });
    expect(id1).toBe(id2); // Same pending decision reused
  });
});
