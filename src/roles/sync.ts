import fs from "fs";
import path from "path";
import { parse as parseYaml } from "yaml";
import type { Sql } from "postgres";
import type { RoleYaml } from "./types";

function readFileOr(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

export interface SyncOptions {
  /**
   * When true, overwrite `recommended_model`, `adapter_type`, and
   * `fallback_model` from role.yaml on every sync. Use this to reset
   * dashboard-configured drift back to library defaults. Default false —
   * preserves per-role dashboard overrides.
   */
  resetModelAndAdapter?: boolean;
}

export async function syncRoleLibrary(
  libraryPath: string,
  sql: Sql,
  options: SyncOptions = {},
) {
  const resetModelAndAdapter = options.resetModelAndAdapter ?? false;
  const entries = fs.readdirSync(libraryPath, { withFileTypes: true });
  const roleDirs = entries.filter((e) => e.isDirectory());

  const fileSystemSlugs: string[] = [];

  for (const dir of roleDirs) {
    const yamlPath = path.join(libraryPath, dir.name, "role.yaml");
    if (!fs.existsSync(yamlPath)) continue;

    const yamlContent = fs.readFileSync(yamlPath, "utf-8");
    const role: RoleYaml = parseYaml(yamlContent);

    const roleMd = readFileOr(path.join(libraryPath, dir.name, "ROLE.md"));
    const soulMd = readFileOr(path.join(libraryPath, dir.name, "SOUL.md"));
    const toolsMd = readFileOr(path.join(libraryPath, dir.name, "TOOLS.md"));

    fileSystemSlugs.push(role.slug);

    // Only overwrite skills from YAML when the YAML explicitly defines a non-empty list.
    // If the YAML has skills: [] (the default), preserve whatever the dashboard/DB has.
    const yamlHasSkills = Array.isArray(role.skills) && role.skills.length > 0;

    // role.yaml `terminal: true` declares the role's completions don't
    // imply follow-up work — used by the Hive Supervisor to suppress
    // unsatisfied_completion / orphan_output false-positives on
    // analysis-only roles. Defaults to false when omitted.
    const terminal = role.terminal === true;
    const resetThisRoleRuntime = resetModelAndAdapter || role.lock_runtime_config === true;
    await sql`
      INSERT INTO role_templates (slug, name, department, type, delegates_to, recommended_model, adapter_type, skills, role_md, soul_md, tools_md, terminal, active, updated_at)
      VALUES (
        ${role.slug},
        ${role.name},
        ${role.department ?? null},
        ${role.type},
        to_jsonb(${role.delegates_to}::text[]),
        ${role.recommended_model ?? null},
        ${role.adapter_type},
        to_jsonb(${role.skills}::text[]),
        ${roleMd},
        ${soulMd},
        ${toolsMd},
        ${terminal},
        true,
        NOW()
      )
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        department = EXCLUDED.department,
        type = EXCLUDED.type,
        delegates_to = EXCLUDED.delegates_to,
        -- Only sync skills from YAML if it has content; otherwise keep DB value (set via dashboard)
        skills = CASE WHEN ${yamlHasSkills} THEN EXCLUDED.skills ELSE role_templates.skills END,
        role_md = EXCLUDED.role_md,
        soul_md = EXCLUDED.soul_md,
        tools_md = EXCLUDED.tools_md,
        -- Terminal is a library-level declaration; always take the YAML value
        -- so toggling it in role.yaml is the single source of truth.
        terminal = EXCLUDED.terminal,
        -- Model and adapter: preserve dashboard overrides by default; reset
        -- to YAML when asked or when role.yaml locks runtime routing.
        recommended_model = CASE WHEN ${resetThisRoleRuntime} THEN EXCLUDED.recommended_model ELSE role_templates.recommended_model END,
        adapter_type = CASE WHEN ${resetThisRoleRuntime} THEN EXCLUDED.adapter_type ELSE role_templates.adapter_type END,
        active = true,
        updated_at = NOW()
    `;
  }

  // Soft-delete roles no longer in filesystem
  if (fileSystemSlugs.length > 0) {
    await sql`
      UPDATE role_templates SET active = false, updated_at = NOW()
      WHERE slug != ALL(${fileSystemSlugs}) AND active = true
    `;
  }
}
