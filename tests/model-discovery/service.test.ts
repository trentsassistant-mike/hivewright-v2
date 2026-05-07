import { describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import {
  runModelDiscoveryImport,
  findModelCatalogRemovalBlockers,
  lockModelCatalogRemovalBlockerTables,
} from "../../src/model-discovery/service";

const HIVE_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

async function seedHive() {
  await truncateAll(sql);
  await sql`DELETE FROM role_templates WHERE slug = 'discovery-role'`;
  await sql`INSERT INTO hives (id, slug, name, type) VALUES (${HIVE_ID}, 'discovery-hive', 'Discovery Hive', 'digital')`;
}

describe("runModelDiscoveryImport", () => {
  it("auto-enables newly discovered text models", async () => {
    await seedHive();

    const result = await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "gemini",
      provider: "google",
      source: "gemini_models_api",
      models: [{
        provider: "google",
        adapterType: "gemini",
        modelId: "google/gemini-new",
        displayName: "Gemini New",
        family: "gemini",
        capabilities: ["text", "code"],
        local: false,
      }],
    });

    const [row] = await sql<{ enabled: boolean; owner_disabled_at: Date | null }[]>`
      SELECT enabled, owner_disabled_at
      FROM hive_models
      WHERE hive_id = ${HIVE_ID}
        AND model_id = 'google/gemini-new'
    `;

    expect(result.modelsImported).toBe(1);
    expect(result.modelsAutoEnabled).toBe(1);
    expect(row.enabled).toBe(true);
    expect(row.owner_disabled_at).toBeNull();
  });

  it("auto-enables newly discovered code-only models", async () => {
    await seedHive();

    const result = await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "codex",
      provider: "openai",
      source: "openai_models_api",
      models: [{
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-code",
        displayName: "GPT Code",
        family: "gpt",
        capabilities: [" CODE "],
        local: false,
      }],
    });

    const [row] = await sql<{ enabled: boolean; owner_disabled_at: Date | null }[]>`
      SELECT enabled, owner_disabled_at
      FROM hive_models
      WHERE hive_id = ${HIVE_ID}
        AND model_id = 'openai-codex/gpt-code'
    `;

    expect(result.modelsImported).toBe(1);
    expect(result.modelsAutoEnabled).toBe(1);
    expect(row.enabled).toBe(true);
    expect(row.owner_disabled_at).toBeNull();
  });

  it("does not re-enable an owner-disabled model", async () => {
    await seedHive();
    await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "gemini",
      provider: "google",
      source: "gemini_models_api",
      models: [{
        provider: "google",
        adapterType: "gemini",
        modelId: "google/gemini-sticky",
        displayName: "Gemini Sticky",
        family: "gemini",
        capabilities: ["text"],
        local: false,
      }],
    });
    await sql`
      UPDATE hive_models
      SET enabled = false,
          owner_disabled_at = NOW(),
          owner_disabled_reason = 'owner disabled'
      WHERE hive_id = ${HIVE_ID}
        AND model_id = 'google/gemini-sticky'
    `;

    await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "gemini",
      provider: "google",
      source: "gemini_models_api",
      models: [{
        provider: "google",
        adapterType: "gemini",
        modelId: "google/gemini-sticky",
        displayName: "Gemini Sticky",
        family: "gemini",
        capabilities: ["text"],
        local: false,
      }],
    });

    const [row] = await sql<{ enabled: boolean; owner_disabled_at: Date | null }[]>`
      SELECT enabled, owner_disabled_at
      FROM hive_models
      WHERE hive_id = ${HIVE_ID}
        AND model_id = 'google/gemini-sticky'
    `;

    expect(row.enabled).toBe(false);
    expect(row.owner_disabled_at).toBeInstanceOf(Date);
  });

  it("can audit the discovery credential without assigning it to hive models", async () => {
    await seedHive();
    const credentialId = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
    await sql`
      INSERT INTO credentials (id, hive_id, name, key, value)
      VALUES (${credentialId}, ${HIVE_ID}, 'Gemini key', 'GEMINI_API_KEY', 'encrypted')
    `;

    const result = await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "gemini",
      provider: "google",
      credentialId,
      assignCredentialToHiveModels: false,
      source: "gemini_models_api",
      models: [{
        provider: "google",
        adapterType: "gemini",
        modelId: "google/gemini-audited",
        displayName: "Gemini Audited",
        family: "gemini",
        capabilities: ["text"],
        local: false,
      }],
    });

    const [run] = await sql<{ credential_id: string | null }[]>`
      SELECT credential_id
      FROM model_discovery_runs
      WHERE id = ${result.runId}
    `;
    const [model] = await sql<{ credential_id: string | null }[]>`
      SELECT credential_id
      FROM hive_models
      WHERE hive_id = ${HIVE_ID}
        AND model_id = 'google/gemini-audited'
    `;

    expect(run.credential_id).toBe(credentialId);
    expect(model.credential_id).toBeNull();
  });

  it("preserves existing routing metadata when discovery omits it", async () => {
    await seedHive();
    await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "gemini",
      provider: "google",
      source: "gemini_models_api",
      models: [{
        provider: "google",
        adapterType: "gemini",
        modelId: "google/gemini-metadata",
        displayName: "Gemini Metadata",
        family: "gemini",
        capabilities: ["text"],
        local: false,
        costPerInputToken: "0.000001000000",
        costPerOutputToken: "0.000002000000",
        benchmarkQualityScore: 91,
        routingCostScore: 20,
        metadataSourceName: "Curated metadata",
        metadataSourceUrl: "https://example.com/models",
      }],
    });

    await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "gemini",
      provider: "google",
      source: "gemini_models_api",
      models: [{
        provider: "google",
        adapterType: "gemini",
        modelId: "google/gemini-metadata",
        displayName: "Gemini Metadata",
        family: "gemini",
        capabilities: ["text"],
        local: false,
      }],
    });

    const [catalog] = await sql<{
      cost_per_input_token: string | null;
      cost_per_output_token: string | null;
      benchmark_quality_score: string | null;
      routing_cost_score: string | null;
      metadata_source_name: string | null;
      metadata_source_url: string | null;
    }[]>`
      SELECT cost_per_input_token,
             cost_per_output_token,
             benchmark_quality_score,
             routing_cost_score,
             metadata_source_name,
             metadata_source_url
      FROM model_catalog
      WHERE model_id = 'google/gemini-metadata'
    `;
    const [hiveModel] = await sql<{
      cost_per_input_token: string | null;
      cost_per_output_token: string | null;
      benchmark_quality_score: string | null;
      routing_cost_score: string | null;
    }[]>`
      SELECT cost_per_input_token,
             cost_per_output_token,
             benchmark_quality_score,
             routing_cost_score
      FROM hive_models
      WHERE hive_id = ${HIVE_ID}
        AND model_id = 'google/gemini-metadata'
    `;

    expect(catalog).toMatchObject({
      cost_per_input_token: "0.000001000000",
      cost_per_output_token: "0.000002000000",
      benchmark_quality_score: "91.00",
      routing_cost_score: "20.00",
      metadata_source_name: "Curated metadata",
      metadata_source_url: "https://example.com/models",
    });
    expect(hiveModel).toMatchObject({
      cost_per_input_token: "0.000001000000",
      cost_per_output_token: "0.000002000000",
      benchmark_quality_score: "91.00",
      routing_cost_score: "20.00",
    });
  });

  it("counts only newly auto-enabled models", async () => {
    await seedHive();
    const first = await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "gemini",
      provider: "google",
      source: "gemini_models_api",
      models: [{
        provider: "google",
        adapterType: "gemini",
        modelId: "google/gemini-repeat",
        displayName: "Gemini Repeat",
        family: "gemini",
        capabilities: ["text"],
        local: false,
      }],
    });

    const second = await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "gemini",
      provider: "google",
      source: "gemini_models_api",
      models: [{
        provider: "google",
        adapterType: "gemini",
        modelId: "google/gemini-repeat",
        displayName: "Gemini Repeat",
        family: "gemini",
        capabilities: ["text"],
        local: false,
      }],
    });

    expect(first.modelsAutoEnabled).toBe(1);
    expect(second.modelsAutoEnabled).toBe(0);
  });

  it("rolls back the discovery run and imported rows on failure", async () => {
    await seedHive();

    await expect(runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "gemini",
      provider: "google",
      source: "gemini_models_api",
      models: [
        {
          provider: "google",
          adapterType: "gemini",
          modelId: "google/gemini-before-failure",
          displayName: "Gemini Before Failure",
          family: "gemini",
          capabilities: ["text"],
          local: false,
        },
        {
          provider: "google",
          adapterType: "gemini",
          modelId: "google/gemini-invalid",
          displayName: "Gemini Invalid",
          family: "gemini",
          capabilities: ["text"],
          local: false,
          costPerInputToken: "not-a-number",
        },
      ],
    })).rejects.toThrow();

    const [runs] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM model_discovery_runs
      WHERE hive_id = ${HIVE_ID}
    `;
    const [catalogRows] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM model_catalog
      WHERE model_id IN ('google/gemini-before-failure', 'google/gemini-invalid')
    `;
    const [hiveRows] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM hive_models
      WHERE hive_id = ${HIVE_ID}
        AND model_id IN ('google/gemini-before-failure', 'google/gemini-invalid')
    `;

    expect(runs.count).toBe("0");
    expect(catalogRows.count).toBe("0");
    expect(hiveRows.count).toBe("0");
  });

  it("marks previously discovered missing models stale", async () => {
    await seedHive();
    await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "gemini",
      provider: "google",
      source: "gemini_models_api",
      models: [{
        provider: "google",
        adapterType: "gemini",
        modelId: "google/gemini-old",
        displayName: "Gemini Old",
        family: "gemini",
        capabilities: ["text"],
        local: false,
      }],
    });

    const result = await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "gemini",
      provider: "google",
      source: "gemini_models_api",
      models: [],
    });

    const [row] = await sql<{ stale_since: Date | null }[]>`
      SELECT stale_since
      FROM model_catalog
      WHERE model_id = 'google/gemini-old'
    `;

    expect(result.modelsMarkedStale).toBe(1);
    expect(row.stale_since).toBeInstanceOf(Date);
  });
});

describe("findModelCatalogRemovalBlockers", () => {
  it("reports role and hive references before deletion", async () => {
    await seedHive();
    const result = await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "codex",
      provider: "openai",
      source: "openai_models_api",
      models: [{
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-new",
        displayName: "GPT New",
        family: "gpt",
        capabilities: ["text", "code"],
        local: false,
      }],
    });
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type, recommended_model)
      VALUES ('discovery-role', 'Discovery Role', 'executor', 'codex', 'openai-codex/gpt-new')
    `;

    const blockers = await findModelCatalogRemovalBlockers(sql, result.catalogIds[0]);

    expect(blockers).toContain("hive_models");
    expect(blockers).toContain("role_templates");
  });

  it("reports role references that use adapter-local model names", async () => {
    await seedHive();
    const result = await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "codex",
      provider: "openai",
      source: "openai_models_api",
      models: [{
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-new",
        displayName: "GPT New",
        family: "gpt",
        capabilities: ["text", "code"],
        local: false,
      }],
    });
    await sql`DELETE FROM hive_models WHERE model_catalog_id = ${result.catalogIds[0]}`;
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type, recommended_model)
      VALUES ('discovery-role', 'Discovery Role', 'executor', 'codex', 'gpt-new')
    `;

    const blockers = await findModelCatalogRemovalBlockers(sql, result.catalogIds[0]);

    expect(blockers).toEqual(["role_templates"]);
  });

  it("reports task and routing policy references", async () => {
    await seedHive();
    const result = await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "codex",
      provider: "openai",
      source: "openai_models_api",
      models: [{
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-new",
        displayName: "GPT New",
        family: "gpt",
        capabilities: ["text", "code"],
        local: false,
      }],
    });
    await sql`DELETE FROM hive_models WHERE model_catalog_id = ${result.catalogIds[0]}`;
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type, recommended_model)
      VALUES ('dev-agent', 'Dev Agent', 'executor', 'codex', 'auto')
      ON CONFLICT (slug) DO NOTHING
    `;
    await sql`
      INSERT INTO tasks (
        hive_id,
        assigned_to,
        created_by,
        status,
        title,
        brief,
        adapter_override,
        model_override,
        model_used
      )
      VALUES (
        ${HIVE_ID},
        'dev-agent',
        'owner',
        'completed',
        'Used removed model',
        'brief',
        'codex',
        'gpt-new',
        'openai-codex/gpt-new'
      )
    `;
    await sql`
      INSERT INTO adapter_config (hive_id, adapter_type, config)
      VALUES (
        ${HIVE_ID},
        'model-routing',
        ${sql.json({
          routeOverrides: {
            "openai:codex:openai-codex/gpt-new": { enabled: false },
          },
          candidates: [{ adapterType: "codex", model: "openai-codex/gpt-new" }],
        })}
      )
    `;

    const blockers = await findModelCatalogRemovalBlockers(sql, result.catalogIds[0]);

    expect(blockers).toContain("tasks");
    expect(blockers).toContain("model_routing_policy");
  });

  it("does not report task override references for a different inherited role adapter", async () => {
    await seedHive();
    const result = await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "codex",
      provider: "openai",
      source: "openai_models_api",
      models: [{
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-new",
        displayName: "GPT New",
        family: "gpt",
        capabilities: ["text", "code"],
        local: false,
      }],
    });
    await sql`DELETE FROM hive_models WHERE model_catalog_id = ${result.catalogIds[0]}`;
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type, recommended_model)
      VALUES ('claude-role', 'Claude Role', 'executor', 'claude-code', 'auto')
      ON CONFLICT (slug) DO UPDATE
        SET adapter_type = EXCLUDED.adapter_type,
            recommended_model = EXCLUDED.recommended_model
    `;
    await sql`
      INSERT INTO tasks (
        hive_id,
        assigned_to,
        created_by,
        status,
        title,
        brief,
        model_override,
        model_used
      )
      VALUES (
        ${HIVE_ID},
        'claude-role',
        'owner',
        'pending',
        'Different adapter override',
        'brief',
        'gpt-new',
        'gpt-new'
      )
    `;

    const blockers = await findModelCatalogRemovalBlockers(sql, result.catalogIds[0]);

    expect(blockers).not.toContain("tasks");
  });

  it("reports task used-model references with a persisted execution adapter", async () => {
    await seedHive();
    const result = await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "codex",
      provider: "openai",
      source: "openai_models_api",
      models: [{
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-new",
        displayName: "GPT New",
        family: "gpt",
        capabilities: ["text", "code"],
        local: false,
      }],
    });
    await sql`DELETE FROM hive_models WHERE model_catalog_id = ${result.catalogIds[0]}`;
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type, recommended_model)
      VALUES ('changed-role', 'Changed Role', 'executor', 'claude-code', 'auto')
      ON CONFLICT (slug) DO UPDATE
        SET adapter_type = EXCLUDED.adapter_type,
            recommended_model = EXCLUDED.recommended_model
    `;
    await sql`
      INSERT INTO tasks (
        hive_id,
        assigned_to,
        created_by,
        status,
        title,
        brief,
        model_used,
        adapter_used
      )
      VALUES (
        ${HIVE_ID},
        'changed-role',
        'owner',
        'completed',
        'Historical codex run',
        'brief',
        'gpt-new',
        'codex'
      )
    `;

    const blockers = await findModelCatalogRemovalBlockers(sql, result.catalogIds[0]);

    expect(blockers).toContain("tasks");
  });

  it("reports terminal historical used-model references when execution adapter is unknown", async () => {
    await seedHive();
    const result = await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "codex",
      provider: "openai",
      source: "openai_models_api",
      models: [{
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-new",
        displayName: "GPT New",
        family: "gpt",
        capabilities: ["text", "code"],
        local: false,
      }],
    });
    await sql`DELETE FROM hive_models WHERE model_catalog_id = ${result.catalogIds[0]}`;
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type, recommended_model)
      VALUES ('legacy-role', 'Legacy Role', 'executor', 'claude-code', 'auto')
      ON CONFLICT (slug) DO UPDATE
        SET adapter_type = EXCLUDED.adapter_type,
            recommended_model = EXCLUDED.recommended_model
    `;
    await sql`
      INSERT INTO tasks (
        hive_id,
        assigned_to,
        created_by,
        status,
        title,
        brief,
        model_used
      )
      VALUES (
        ${HIVE_ID},
        'legacy-role',
        'owner',
        'completed',
        'Legacy codex run',
        'brief',
        'gpt-new'
      )
    `;

    const blockers = await findModelCatalogRemovalBlockers(sql, result.catalogIds[0]);

    expect(blockers).toContain("tasks");
  });

  it("reports legacy unresolvable used-model references when execution adapter is unknown", async () => {
    await seedHive();
    const result = await runModelDiscoveryImport(sql, {
      hiveId: HIVE_ID,
      adapterType: "codex",
      provider: "openai",
      source: "openai_models_api",
      models: [{
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-new",
        displayName: "GPT New",
        family: "gpt",
        capabilities: ["text", "code"],
        local: false,
      }],
    });
    await sql`DELETE FROM hive_models WHERE model_catalog_id = ${result.catalogIds[0]}`;
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type, recommended_model)
      VALUES ('legacy-unresolvable-role', 'Legacy Unresolvable Role', 'executor', 'claude-code', 'auto')
      ON CONFLICT (slug) DO UPDATE
        SET adapter_type = EXCLUDED.adapter_type,
            recommended_model = EXCLUDED.recommended_model
    `;
    await sql`
      INSERT INTO tasks (
        hive_id,
        assigned_to,
        created_by,
        status,
        title,
        brief,
        model_used
      )
      VALUES (
        ${HIVE_ID},
        'legacy-unresolvable-role',
        'owner',
        'unresolvable',
        'Legacy unresolvable codex run',
        'brief',
        'gpt-new'
      )
    `;

    const blockers = await findModelCatalogRemovalBlockers(sql, result.catalogIds[0]);

    expect(blockers).toContain("tasks");
  });
});

describe("lockModelCatalogRemovalBlockerTables", () => {
  it("locks every table that can hold cleanup blockers", async () => {
    const statements: string[] = [];
    const fakeSql = ((strings: TemplateStringsArray) => {
      statements.push(strings.join("?").replace(/\s+/g, " ").trim());
      return Promise.resolve([]);
    }) as typeof sql;

    await lockModelCatalogRemovalBlockerTables(fakeSql);

    expect(statements).toEqual([
      "SELECT set_config('lock_timeout', ?, true)",
      "LOCK TABLE hive_models, role_templates, tasks, adapter_config IN SHARE MODE",
    ]);
  });
});
