import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixtureNamespace, testSql as sql, truncateAll } from "../_lib/test-db";
import { runHiveSetup, type HiveSetupRequest, type HiveSetupStep } from "@/hives/setup";

let workspaceRoot = "";
const originalEncryptionKey = process.env.ENCRYPTION_KEY;
const originalWorkspaceRoot = process.env.HIVES_WORKSPACE_ROOT;

function buildRequest(slug: string): HiveSetupRequest {
  return {
    hive: {
      name: "Atomic Setup Hive",
      slug,
      type: "digital",
      description: "Atomic setup coverage",
      mission: "Prove setup is all-or-nothing",
    },
    roleOverrides: {
      "dev-agent": {
        adapterType: "codex",
        recommendedModel: "openai-codex/gpt-5.5",
      },
    },
    connectors: [{
      connectorSlug: "discord-webhook",
      displayName: "Discord",
      fields: {
        webhookUrl: "https://example.test/webhook",
        defaultUsername: "HiveWright",
      },
    }],
    projects: [{
      name: "Website",
      slug: "website",
    }],
    initialGoal: "Launch the first owner workflow",
    operatingPreferences: {
      maxConcurrentAgents: 4,
      proactiveWork: true,
      memorySearch: true,
      requestSorting: "balanced",
    },
  };
}

async function countRows(tableName: "hives" | "adapter_config" | "connector_installs" | "credentials" | "projects" | "goals" | "schedules") {
  const [{ count }] = await sql.unsafe(`SELECT COUNT(*)::int AS count FROM ${tableName}`) as Array<{ count: number }>;
  return count;
}

describe("runHiveSetup atomicity", () => {
  beforeEach(async () => {
    await truncateAll(sql);
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hw-hive-setup-"));
    process.env.ENCRYPTION_KEY = "test-encryption-key";
    process.env.HIVES_WORKSPACE_ROOT = workspaceRoot;
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
    if (originalWorkspaceRoot === undefined) {
      delete process.env.HIVES_WORKSPACE_ROOT;
    } else {
      process.env.HIVES_WORKSPACE_ROOT = originalWorkspaceRoot;
    }
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = "";
    }
  });

  it.each([
    "role-overrides",
    "connectors",
    "projects",
    "initial-goal",
  ] as const)("rolls back all setup writes when %s fails", async (failAfterStep: HiveSetupStep) => {
    const fixture = createFixtureNamespace(`hive-setup-${failAfterStep}`);
    const slug = fixture.slug("atomic-hive");
    const request = buildRequest(slug);
    const hiveRoot = path.join(workspaceRoot, slug);
    const [roleBefore] = await sql<{ adapter_type: string; recommended_model: string | null }[]>`
      SELECT adapter_type, recommended_model
      FROM role_templates
      WHERE slug = 'dev-agent'
      LIMIT 1
    `;

    await expect(runHiveSetup(sql, request, { failAfterStep })).rejects.toThrow(
      `Forced hive setup failure after ${failAfterStep}.`,
    );

    expect(await countRows("hives")).toBe(0);
    expect(await countRows("adapter_config")).toBe(0);
    expect(await countRows("connector_installs")).toBe(0);
    expect(await countRows("credentials")).toBe(0);
    expect(await countRows("projects")).toBe(0);
    expect(await countRows("goals")).toBe(0);
    expect(await countRows("schedules")).toBe(0);
    expect(fs.existsSync(hiveRoot)).toBe(false);

    const [roleAfter] = await sql<{ adapter_type: string; recommended_model: string | null }[]>`
      SELECT adapter_type, recommended_model
      FROM role_templates
      WHERE slug = 'dev-agent'
      LIMIT 1
    `;
    expect(roleAfter).toEqual(roleBefore);
  });

  it("creates the hive and required setup rows on success", async () => {
    const fixture = createFixtureNamespace("hive-setup-success");
    const slug = fixture.slug("atomic-success");
    const request = buildRequest(slug);
    const hiveRoot = path.join(workspaceRoot, slug);
    const [roleBefore] = await sql<{ adapter_type: string; recommended_model: string | null }[]>`
      SELECT adapter_type, recommended_model
      FROM role_templates
      WHERE slug = 'dev-agent'
      LIMIT 1
    `;

    try {
      const result = await runHiveSetup(sql, request);

      expect(result).toMatchObject({
        name: "Atomic Setup Hive",
        slug,
        type: "digital",
      });
      expect(await countRows("hives")).toBe(1);
      expect(await countRows("adapter_config")).toBe(3);
      expect(await countRows("connector_installs")).toBe(1);
      expect(await countRows("credentials")).toBe(1);
      expect(await countRows("projects")).toBe(1);
      expect(await countRows("goals")).toBe(1);
      expect(await countRows("schedules")).toBe(7);
      expect(fs.existsSync(path.join(hiveRoot, "projects"))).toBe(true);
      expect(fs.existsSync(path.join(hiveRoot, "skills"))).toBe(true);
      expect(fs.existsSync(path.join(hiveRoot, "ea"))).toBe(true);

      const [roleAfter] = await sql<{ adapter_type: string; recommended_model: string | null }[]>`
        SELECT adapter_type, recommended_model
        FROM role_templates
        WHERE slug = 'dev-agent'
        LIMIT 1
      `;
      expect(roleAfter).toEqual({
        adapter_type: "codex",
        recommended_model: "openai-codex/gpt-5.5",
      });
    } finally {
      await sql`
        UPDATE role_templates
        SET adapter_type = ${roleBefore.adapter_type},
            recommended_model = ${roleBefore.recommended_model}
        WHERE slug = 'dev-agent'
      `;
    }
  });
});
