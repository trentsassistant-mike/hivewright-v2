import { describe, it, expect } from "vitest";
import { syncRoleLibrary } from "@/roles/sync";
import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import { testSql as sql } from "../_lib/test-db";

const roleLibraryPath = path.resolve(__dirname, "../../role-library");

// No beforeEach cleanup: syncRoleLibrary is idempotent by design.
// role_templates is READ_ONLY_TABLES and is not truncated between tests.

describe("syncRoleLibrary", () => {
  it("defaults role-library runtime routing to automatic model selection", () => {
    const roleDirs = fs.readdirSync(roleLibraryPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const roleDir of roleDirs) {
      const yamlPath = path.join(roleLibraryPath, roleDir, "role.yaml");
      if (!fs.existsSync(yamlPath)) continue;
      const yaml = parseYaml(fs.readFileSync(yamlPath, "utf-8")) as {
        adapter_type?: string;
        recommended_model?: string;
        fallback_adapter_type?: string;
        fallback_model?: string;
        lock_runtime_config?: boolean;
      };

      expect(yaml.adapter_type, `${roleDir} adapter_type`).toBe("auto");
      expect(yaml.recommended_model, `${roleDir} recommended_model`).toBe("auto");
      expect(yaml.fallback_adapter_type, `${roleDir} fallback_adapter_type`).toBeUndefined();
      expect(yaml.fallback_model, `${roleDir} fallback_model`).toBeUndefined();
      expect(yaml.lock_runtime_config, `${roleDir} lock_runtime_config`).toBeUndefined();
    }
  });

  it("syncs all role templates from filesystem to database", async () => {
    await syncRoleLibrary(roleLibraryPath, sql);

    const roles = await sql`SELECT slug, name, type, adapter_type, active FROM role_templates ORDER BY slug`;
    const slugs = roles.map((r) => r.slug);

    expect(slugs).toContain("goal-supervisor");
    expect(slugs).toContain("doctor");
    expect(slugs).toContain("qa");
    expect(slugs).toContain("dev-agent");
    expect(slugs).toContain("bookkeeper");
    expect(slugs).toContain("research-analyst");
    expect(slugs).toContain("content-writer");
    expect(slugs).toContain("image-designer");
    expect(slugs).toContain("frontend-designer");

    const doctor = roles.find((r) => r.slug === "doctor");
    expect(doctor?.type).toBe("system");
    expect(doctor?.active).toBe(true);
  });

  it("loads image-designer role metadata and image generation contract", async () => {
    await syncRoleLibrary(roleLibraryPath, sql, { resetModelAndAdapter: true });

    const [role] = await sql<Array<{
      slug: string;
      name: string;
      department: string;
      type: string;
      adapter_type: string;
      recommended_model: string;
      active: boolean;
      role_md: string;
      tools_md: string;
    }>>`
      SELECT slug, name, department, type, adapter_type, recommended_model, active, role_md, tools_md
      FROM role_templates
      WHERE slug = 'image-designer'
    `;

    expect(role).toMatchObject({
      slug: "image-designer",
      name: "Image Designer",
      department: "design",
      type: "executor",
      adapter_type: "auto",
      recommended_model: "auto",
      active: true,
    });
    expect(role.role_md).toContain("image-generation capable adapter selected by HiveWright routing");
    expect(role.role_md).not.toContain("gpt-image-2-2026-04-21");
    expect(role.role_md).not.toContain("Do not use `gpt-image-1`, DALL-E 3");
    expect(role.role_md).toContain("`intent`");
    expect(role.role_md).toContain("`references`");
    expect(role.role_md).toContain("`dimensions`");
    expect(role.role_md).toContain("`style`");
    expect(role.role_md).toContain("`output_count`");
    expect(role.role_md).toContain("`downstream_use`");
    expect(role.role_md).toContain("image generation adapter");
    expect(role.role_md).toContain("`work_product`");
    expect(role.tools_md).toContain("image/png");
    expect(role.tools_md).toContain("image/jpeg");
    expect(role.tools_md).toContain("HiveWright-selected image generation adapter");
    expect(role.tools_md).toContain("calculated cost metadata");
  });

  it("preserves dashboard runtime config for image-designer during normal sync", async () => {
    await syncRoleLibrary(roleLibraryPath, sql, { resetModelAndAdapter: true });
    await sql`
      UPDATE role_templates
      SET adapter_type = 'codex', recommended_model = 'gpt-image-1'
      WHERE slug = 'image-designer'
    `;

    await syncRoleLibrary(roleLibraryPath, sql);

    const [role] = await sql<Array<{
      adapter_type: string;
      recommended_model: string;
    }>>`
      SELECT adapter_type, recommended_model
      FROM role_templates
      WHERE slug = 'image-designer'
    `;

    expect(role).toMatchObject({
      adapter_type: "codex",
      recommended_model: "gpt-image-1",
    });
  });

  it("preserves dashboard runtime config for frontend-designer during normal sync", async () => {
    await syncRoleLibrary(roleLibraryPath, sql, { resetModelAndAdapter: true });
    await sql`
      UPDATE role_templates
      SET adapter_type = 'claude-code', recommended_model = 'anthropic/claude-opus-4-7'
      WHERE slug = 'frontend-designer'
    `;

    await syncRoleLibrary(roleLibraryPath, sql);

    const [role] = await sql<Array<{
      adapter_type: string;
      recommended_model: string;
      skills: string[];
    }>>`
      SELECT adapter_type, recommended_model, skills
      FROM role_templates
      WHERE slug = 'frontend-designer'
    `;

    expect(role).toMatchObject({
      adapter_type: "claude-code",
      recommended_model: "anthropic/claude-opus-4-7",
    });
    expect(Array.isArray(role.skills)).toBe(true);
    expect(role.skills).toContain("frontend-design:frontend-design");
    expect(role.skills).toContain("figma:figma-implement-design");
  });

  it("loads frontend-designer role metadata and provider-agnostic design lane contract", async () => {
    await syncRoleLibrary(roleLibraryPath, sql, { resetModelAndAdapter: true });

    const [role] = await sql<Array<{
      slug: string;
      name: string;
      department: string;
      type: string;
      adapter_type: string;
      recommended_model: string;
      active: boolean;
      skills: string[];
      role_md: string;
      tools_md: string;
    }>>`
      SELECT slug, name, department, type, adapter_type, recommended_model, active, skills, role_md, tools_md
      FROM role_templates
      WHERE slug = 'frontend-designer'
    `;

    expect(role).toMatchObject({
      slug: "frontend-designer",
      name: "Frontend Designer",
      department: "design",
      type: "executor",
      adapter_type: "auto",
      recommended_model: "auto",
      active: true,
    });
    expect(role.skills).toContain("frontend-design:frontend-design");
    expect(role.skills).toContain("figma:figma-implement-design");
    expect(Array.isArray(role.skills)).toBe(true);
    expect(role.role_md).toContain("image work_product references");
    expect(role.role_md).toContain("Use the existing image-read capability");
    expect(role.role_md).toContain("Tailwind");
    expect(role.role_md).toContain("JSX");
    expect(role.role_md).toContain("shadcn-oriented");
    expect(role.role_md).toContain("Figma-shaped");
    expect(role.role_md).toContain("normal HiveWright role adapter selected by routing");
    expect(role.role_md).not.toContain("Claude");
    expect(role.role_md).not.toContain("Anthropic");
    expect(role.tools_md).toContain("frontend-design:frontend-design");
    expect(role.tools_md).toContain("figma:figma-implement-design");
    expect(role.tools_md).toContain("runtime model and adapter are selected by HiveWright routing");
    expect(role.tools_md).not.toContain("Claude");
    expect(role.tools_md).not.toContain("Anthropic");
    expect(role.tools_md).not.toContain("Opus");
    expect(role.tools_md).not.toContain("claude-code");
  });

  it("upserts on re-sync without duplicating", async () => {
    await syncRoleLibrary(roleLibraryPath, sql);
    await syncRoleLibrary(roleLibraryPath, sql);

    const roles = await sql`SELECT slug FROM role_templates WHERE slug = 'doctor'`;
    expect(roles.length).toBe(1);
  });

  it("soft-deletes roles removed from filesystem", async () => {
    // Insert a role that doesn't exist in the filesystem
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('phantom-role', 'Phantom', 'executor', 'claude-code')
      ON CONFLICT (slug) DO UPDATE SET active = true
    `;

    await syncRoleLibrary(roleLibraryPath, sql);

    const [phantom] = await sql`SELECT active FROM role_templates WHERE slug = 'phantom-role'`;
    expect(phantom.active).toBe(false);

    await sql`DELETE FROM role_templates WHERE slug = 'phantom-role'`;
  });

  it("loads ROLE.md content into role_md column", async () => {
    await syncRoleLibrary(roleLibraryPath, sql);

    const [doctor] = await sql`SELECT role_md FROM role_templates WHERE slug = 'doctor'`;
    expect(doctor.role_md).toContain("Doctor");
    expect(doctor.role_md).toContain("self-healing");
  });

  // Terminal-flag seam: the Hive Supervisor's unsatisfied_completion and
  // orphan_output detectors read role_templates.terminal to suppress
  // self-referential false positives from watchdog/system roles. role.yaml is
  // the single source of truth, and syncRoleLibrary is the only writer on this
  // seam, so regressions here would silently reopen the 2026-04-22 loop.
  it("persists terminal: false from role.yaml for follow-up-producing executor roles (research-analyst, design-agent)", async () => {
    await syncRoleLibrary(roleLibraryPath, sql);

    const rows = await sql<Array<{ slug: string; terminal: boolean }>>`
      SELECT slug, terminal FROM role_templates
      WHERE slug IN ('research-analyst', 'design-agent')
      ORDER BY slug
    `;
    expect(rows).toEqual([
      { slug: "design-agent", terminal: false },
      { slug: "research-analyst", terminal: false },
    ]);
  });

  it("persists terminal: true for watchdog + system roles (hive-supervisor, qa, doctor, goal-supervisor)", async () => {
    await syncRoleLibrary(roleLibraryPath, sql);

    const rows = await sql<Array<{ slug: string; terminal: boolean }>>`
      SELECT slug, terminal FROM role_templates
      WHERE slug IN ('hive-supervisor', 'qa', 'doctor', 'goal-supervisor')
      ORDER BY slug
    `;
    expect(rows).toEqual([
      { slug: "doctor", terminal: true },
      { slug: "goal-supervisor", terminal: true },
      { slug: "hive-supervisor", terminal: true },
      { slug: "qa", terminal: true },
    ]);
  });

  it("persists terminal: false for roles without a terminal key (dev-agent)", async () => {
    await syncRoleLibrary(roleLibraryPath, sql);

    const [devAgent] = await sql<Array<{ terminal: boolean }>>`
      SELECT terminal FROM role_templates WHERE slug = 'dev-agent'
    `;
    expect(devAgent.terminal).toBe(false);
  });

  it("resyncs terminal from role.yaml, overwriting drift in the DB (YAML is single source of truth)", async () => {
    await syncRoleLibrary(roleLibraryPath, sql);
    // Simulate drift: someone flips research-analyst to terminal in the DB.
    await sql`UPDATE role_templates SET terminal = true WHERE slug = 'research-analyst'`;

    await syncRoleLibrary(roleLibraryPath, sql);

    const [row] = await sql<Array<{ terminal: boolean }>>`
      SELECT terminal FROM role_templates WHERE slug = 'research-analyst'
    `;
    expect(row.terminal).toBe(false);
  });
});
