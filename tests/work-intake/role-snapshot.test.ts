import { describe, it, expect, beforeEach } from "vitest";
import { getRoleSnapshot, clearRoleSnapshotCache } from "@/work-intake/role-snapshot";
import { testSql as sql, truncateAll } from "../_lib/test-db";

beforeEach(async () => {
  await truncateAll(sql);
  clearRoleSnapshotCache();
  await sql`
    INSERT INTO role_templates (slug, name, department, type, adapter_type, role_md, active)
    VALUES
      ('rs-dev', 'Dev', 'engineering', 'executor', 'claude-code',
       '# Dev\n\nBuilds features in TypeScript and React.\n\n## Capabilities', true),
      ('rs-sup', 'Supervisor', 'operations', 'system', 'claude-code',
       '# Supervisor', true),
      ('rs-data', 'Data Analyst', 'research', 'executor', 'claude-code',
       '# Data Analyst\n\nExecutes quantitative research and statistical analysis.', true),
      ('rs-inactive', 'Dormant', 'misc', 'executor', 'claude-code',
       '# Dormant\n\nNot in use.', false)
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name,
      department = EXCLUDED.department,
      type = EXCLUDED.type,
      role_md = EXCLUDED.role_md,
      active = EXCLUDED.active
  `;
});

describe("getRoleSnapshot", () => {
  it("returns one line per active executor role with the first non-heading line", async () => {
    const lines = await getRoleSnapshot(sql);
    const devLine = lines.find((l) => l.startsWith("- rs-dev"));
    const dataLine = lines.find((l) => l.startsWith("- rs-data"));
    expect(devLine).toBe(
      "- rs-dev (engineering): Builds features in TypeScript and React.",
    );
    expect(dataLine).toBe(
      "- rs-data (research): Executes quantitative research and statistical analysis.",
    );
  });

  it("excludes system roles", async () => {
    const lines = await getRoleSnapshot(sql);
    expect(lines.some((l) => l.includes("rs-sup"))).toBe(false);
  });

  it("excludes inactive roles", async () => {
    const lines = await getRoleSnapshot(sql);
    expect(lines.some((l) => l.includes("rs-inactive"))).toBe(false);
  });

  it("serves from cache on second call within TTL", async () => {
    const a = await getRoleSnapshot(sql);
    // mutate DB — if cache works, we still get the old snapshot
    await sql`UPDATE role_templates SET active = false WHERE slug = 'rs-dev'`;
    const b = await getRoleSnapshot(sql);
    expect(b).toEqual(a);
  });

  it("refreshes after clearRoleSnapshotCache()", async () => {
    await getRoleSnapshot(sql);
    await sql`UPDATE role_templates SET active = false WHERE slug = 'rs-dev'`;
    clearRoleSnapshotCache();
    const lines = await getRoleSnapshot(sql);
    expect(lines.some((l) => l.startsWith("- rs-dev"))).toBe(false);
  });
});
