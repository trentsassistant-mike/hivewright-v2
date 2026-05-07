import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, PATCH } from "../../src/app/api/model-setup/route";
import { POST as refreshMetadata } from "../../src/app/api/model-setup/metadata/route";
import { createRuntimeCredentialFingerprint } from "../../src/model-health/probe-runner";
import { upsertModelCatalogEntry } from "../../src/model-catalog/catalog";
import { upsertModelCapabilityScores } from "../../src/model-catalog/capability-scores";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_ID = "aaaaaaaa-7878-4787-8787-aaaaaaaaaaaa";
const OTHER_HIVE_ID = "bbbbbbbb-7878-4787-8787-bbbbbbbbbbbb";
const CREDENTIAL_ID = "cccccccc-7878-4787-8787-cccccccccccc";
const OTHER_CREDENTIAL_ID = "dddddddd-7878-4787-8787-dddddddddddd";
const FINGERPRINT = "2222222222222222222222222222222222222222222222222222222222222222";
const OTHER_FINGERPRINT = "3333333333333333333333333333333333333333333333333333333333333333";

let originalFetch: typeof globalThis.fetch;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES
      (${HIVE_ID}, 'model-setup-hive', 'Model Setup Hive', 'digital'),
      (${OTHER_HIVE_ID}, 'other-model-setup-hive', 'Other Model Setup Hive', 'digital')
  `;
  await sql`
    INSERT INTO credentials (id, hive_id, name, key, value, fingerprint)
    VALUES
      (${CREDENTIAL_ID}, ${HIVE_ID}, 'OpenAI Billing A', 'OPENAI_API_KEY', 'encrypted', ${FINGERPRINT}),
      (${OTHER_CREDENTIAL_ID}, ${OTHER_HIVE_ID}, 'OpenAI Billing B', 'OPENAI_API_KEY', 'encrypted', ${OTHER_FINGERPRINT})
  `;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("/api/model-setup", () => {
  it("returns global model facts with selected hive usage and credential-scoped health", async () => {
    const catalogId = await upsertModelCatalogEntry(sql, {
      provider: "openai",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      displayName: "GPT-5.5",
      family: "gpt-5",
      capabilities: ["text", "code"],
      local: false,
      benchmarkQualityScore: 96,
      routingCostScore: 70,
      costPerInputToken: "0.000005",
      costPerOutputToken: "0.000030",
      metadataSourceName: "OpenAI pricing",
      metadataSourceUrl: "https://openai.com/api/pricing/",
    });

    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        model_catalog_id,
        credential_id,
        enabled
      )
      VALUES
        (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', ${catalogId}, ${CREDENTIAL_ID}, true),
        (${OTHER_HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', ${catalogId}, ${OTHER_CREDENTIAL_ID}, true)
    `;
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status, latency_ms)
      VALUES
        (${FINGERPRINT}, 'openai-codex/gpt-5.5', 'healthy', 111),
        (${OTHER_FINGERPRINT}, 'openai-codex/gpt-5.5', 'unhealthy', 999)
    `;
    await upsertModelCapabilityScores(sql, [
      {
        modelCatalogId: catalogId,
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-5.5",
        canonicalModelId: "openai-codex/gpt-5.5",
        axis: "writing",
        score: 46.9,
        rawScore: "46.9",
        source: "llm-stats",
        sourceUrl: "https://llm-stats.example/benchmarks",
        benchmarkName: "Writing Arena",
        modelVersionMatched: "GPT-5.5",
        confidence: "medium",
      },
    ]);

    const res = await GET(new Request(`http://localhost/api/model-setup?hiveId=${HIVE_ID}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.models).toHaveLength(1);
    expect(body.data.models[0]).toMatchObject({
      provider: "openai",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      displayName: "GPT-5.5",
      hiveEnabled: true,
      credentialId: CREDENTIAL_ID,
      credentialName: "OpenAI Billing A",
      status: "healthy",
      latencyMs: 111,
      benchmarkQualityScore: 96,
      costPerInputToken: "0.000005000000",
      costPerOutputToken: "0.000030000000",
    });
    expect(body.data.models[0].capabilityScores).toEqual([
      expect.objectContaining({
        axis: "writing",
        score: 46.9,
        rawScore: "46.9",
        source: "llm-stats",
        sourceUrl: "https://llm-stats.example/benchmarks",
        benchmarkName: "Writing Arena",
        modelVersionMatched: "GPT-5.5",
        confidence: "medium",
      }),
    ]);
    expect(body.data.models[0].capabilityScores[0].updatedAt).toBeTruthy();
    expect(body.data.credentials).toEqual([
      expect.objectContaining({ id: CREDENTIAL_ID, name: "OpenAI Billing A" }),
    ]);
  });

  it("returns all sourced capability scores per axis", async () => {
    const catalogId = await upsertModelCatalogEntry(sql, {
      provider: "openai",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      displayName: "GPT-5.5",
      family: "gpt-5",
      capabilities: ["text", "code"],
      local: false,
      benchmarkQualityScore: 96,
      routingCostScore: 70,
      costPerInputToken: "0.000005",
      costPerOutputToken: "0.000030",
      metadataSourceName: "OpenAI pricing",
      metadataSourceUrl: "https://openai.com/api/pricing/",
    });

    await sql`
      INSERT INTO model_capability_scores (
        model_catalog_id,
        provider,
        adapter_type,
        model_id,
        canonical_model_id,
        axis,
        score,
        raw_score,
        source,
        source_url,
        benchmark_name,
        model_version_matched,
        confidence,
        updated_at
      )
      VALUES
        (${catalogId}, 'openai', 'codex', 'openai-codex/gpt-5.5', 'openai-codex/gpt-5.5', 'writing', 41.1, '41.1', 'source-low-new', 'https://example.com/low', 'Writing Bench', 'GPT-5.5', 'low', '2026-01-03T00:00:00Z'),
        (${catalogId}, 'openai', 'codex', 'openai-codex/gpt-5.5', 'openai-codex/gpt-5.5', 'writing', 52.2, '52.2', 'source-high-old', 'https://example.com/high', 'Writing Bench', 'GPT-5.5', 'high', '2026-01-01T00:00:00Z'),
        (${catalogId}, 'openai', 'codex', 'openai-codex/gpt-5.5', 'openai-codex/gpt-5.5', 'writing', 48.8, '48.8', 'source-medium-newer', 'https://example.com/medium', 'Writing Bench', 'GPT-5.5', 'medium', '2026-01-04T00:00:00Z')
    `;

    const res = await GET(new Request(`http://localhost/api/model-setup?hiveId=${HIVE_ID}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.models[0].capabilityScores).toEqual([
      expect.objectContaining({
        axis: "writing",
        score: 52.2,
        source: "source-high-old",
        confidence: "high",
      }),
      expect.objectContaining({
        axis: "writing",
        score: 48.8,
        source: "source-medium-newer",
        confidence: "medium",
      }),
      expect.objectContaining({
        axis: "writing",
        score: 41.1,
        source: "source-low-new",
        confidence: "low",
      }),
    ]);
  });

  it("collapses legacy model aliases on the setup page", async () => {
    const catalogId = await upsertModelCatalogEntry(sql, {
      provider: "openai",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      displayName: "GPT-5.5",
      family: "gpt-5",
      capabilities: ["text", "code"],
      local: false,
      benchmarkQualityScore: 96,
      routingCostScore: 70,
      costPerInputToken: "0.000005",
      costPerOutputToken: "0.000030",
      metadataSourceName: "OpenAI pricing",
      metadataSourceUrl: "https://openai.com/api/pricing/",
    });

    await sql`
      INSERT INTO model_catalog (
        provider,
        adapter_type,
        model_id,
        display_name,
        family,
        capabilities,
        local,
        updated_at
      )
      VALUES (
        'openai',
        'codex',
        'gpt-5.5',
        'gpt-5.5',
        'gpt-5',
        '["text", "code"]'::jsonb,
        false,
        NOW()
      )
    `;

    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        model_catalog_id,
        credential_id,
        enabled
      )
      VALUES
        (${HIVE_ID}, 'openai', 'gpt-5.5', 'codex', ${catalogId}, ${CREDENTIAL_ID}, true),
        (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', ${catalogId}, ${CREDENTIAL_ID}, true)
    `;

    const res = await GET(new Request(`http://localhost/api/model-setup?hiveId=${HIVE_ID}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.models).toHaveLength(1);
    expect(body.data.models[0]).toMatchObject({
      modelCatalogId: catalogId,
      modelId: "openai-codex/gpt-5.5",
      displayName: "GPT-5.5",
      benchmarkQualityScore: 96,
      costPerInputToken: "0.000005000000",
      hiveEnabled: true,
    });
  });

  it("updates only selected hive usage when assigning credentials and enablement", async () => {
    const catalogId = await upsertModelCatalogEntry(sql, {
      provider: "openai",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      displayName: "GPT-5.5",
      family: "gpt-5",
      capabilities: ["text", "code"],
      local: false,
      benchmarkQualityScore: 96,
      routingCostScore: 70,
      costPerInputToken: "0.000005",
      costPerOutputToken: "0.000030",
      metadataSourceName: "OpenAI pricing",
      metadataSourceUrl: "https://openai.com/api/pricing/",
    });

    const res = await PATCH(new Request("http://localhost/api/model-setup", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: HIVE_ID,
        modelCatalogId: catalogId,
        enabled: true,
        credentialId: CREDENTIAL_ID,
        fallbackPriority: 12,
      }),
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.model).toMatchObject({
      modelCatalogId: catalogId,
      hiveEnabled: true,
      credentialId: CREDENTIAL_ID,
      fallbackPriority: 12,
    });

    const rows = await sql<{ hive_id: string; credential_id: string | null }[]>`
      SELECT hive_id, credential_id
      FROM hive_models
      WHERE model_catalog_id = ${catalogId}
      ORDER BY hive_id
    `;

    expect(rows).toEqual([
      { hive_id: HIVE_ID, credential_id: CREDENTIAL_ID },
    ]);
  });

  it("returns and updates hive models that are not linked to catalog metadata yet", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        enabled
      )
      VALUES (${HIVE_ID}, 'openai', 'gpt-5.5', 'codex', false)
      RETURNING id
    `;

    const listRes = await GET(new Request(`http://localhost/api/model-setup?hiveId=${HIVE_ID}`));
    const listBody = await listRes.json();

    expect(listRes.status).toBe(200);
    expect(listBody.data.models).toEqual([
      expect.objectContaining({
        modelCatalogId: null,
        hiveModelId: row.id,
        provider: "openai",
        adapterType: "codex",
        modelId: "gpt-5.5",
        hiveEnabled: false,
      }),
    ]);

    const updateRes = await PATCH(new Request("http://localhost/api/model-setup", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: HIVE_ID,
        hiveModelId: row.id,
        enabled: true,
        credentialId: CREDENTIAL_ID,
      }),
    }));
    const updateBody = await updateRes.json();

    expect(updateRes.status).toBe(200);
    expect(updateBody.data.model).toMatchObject({
      hiveModelId: row.id,
      hiveEnabled: true,
      credentialId: CREDENTIAL_ID,
    });
  });

  it("sets owner-disabled metadata when disabling an existing hive model", async () => {
    const catalogId = await upsertModelCatalogEntry(sql, {
      provider: "google",
      adapterType: "gemini",
      modelId: "google/gemini-lock",
      displayName: "Gemini Lock",
      family: "gemini",
      capabilities: ["text"],
      local: false,
      benchmarkQualityScore: null,
      routingCostScore: null,
      costPerInputToken: null,
      costPerOutputToken: null,
      metadataSourceName: "test",
      metadataSourceUrl: null,
    });
    const [usage] = await sql<{ id: string }[]>`
      INSERT INTO hive_models (hive_id, provider, adapter_type, model_id, model_catalog_id, enabled)
      VALUES (${HIVE_ID}, 'google', 'gemini', 'google/gemini-lock', ${catalogId}, true)
      RETURNING id
    `;

    const res = await PATCH(new Request("http://localhost/api/model-setup", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: HIVE_ID,
        hiveModelId: usage.id,
        enabled: false,
      }),
    }));
    const body = await res.json();

    const [row] = await sql<{
      enabled: boolean;
      owner_disabled_at: Date | null;
      owner_disabled_reason: string | null;
    }[]>`
      SELECT enabled, owner_disabled_at, owner_disabled_reason
      FROM hive_models
      WHERE id = ${usage.id}
    `;
    expect(res.status).toBe(200);
    expect(body.data.model).toMatchObject({
      hiveModelId: usage.id,
      hiveEnabled: false,
      ownerDisabledReason: "Disabled by owner in model setup",
    });
    expect(body.data.model.ownerDisabledAt).toBeTruthy();
    expect(row.enabled).toBe(false);
    expect(row.owner_disabled_at).toBeInstanceOf(Date);
    expect(row.owner_disabled_reason).toBe("Disabled by owner in model setup");
  });

  it("clears owner-disabled metadata when re-enabling an existing hive model", async () => {
    const [usage] = await sql<{ id: string }[]>`
      INSERT INTO hive_models (
        hive_id,
        provider,
        adapter_type,
        model_id,
        enabled,
        owner_disabled_at,
        owner_disabled_reason
      )
      VALUES (${HIVE_ID}, 'google', 'gemini', 'google/gemini-unlock', false, NOW(), 'owner disabled')
      RETURNING id
    `;

    const res = await PATCH(new Request("http://localhost/api/model-setup", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: HIVE_ID,
        hiveModelId: usage.id,
        enabled: true,
      }),
    }));
    const body = await res.json();

    const [row] = await sql<{
      enabled: boolean;
      owner_disabled_at: Date | null;
      owner_disabled_reason: string | null;
    }[]>`
      SELECT enabled, owner_disabled_at, owner_disabled_reason
      FROM hive_models
      WHERE id = ${usage.id}
    `;
    expect(res.status).toBe(200);
    expect(body.data.model).toMatchObject({
      hiveModelId: usage.id,
      hiveEnabled: true,
      ownerDisabledAt: null,
      ownerDisabledReason: null,
    });
    expect(row.enabled).toBe(true);
    expect(row.owner_disabled_at).toBeNull();
    expect(row.owner_disabled_reason).toBeNull();
  });

  it("clears owner-disabled metadata when re-enabling through catalog upsert", async () => {
    const catalogId = await upsertModelCatalogEntry(sql, {
      provider: "google",
      adapterType: "gemini",
      modelId: "google/gemini-discovery-lock",
      displayName: "Gemini Discovery Lock",
      family: "gemini",
      capabilities: ["text"],
      local: false,
      benchmarkQualityScore: null,
      routingCostScore: null,
      costPerInputToken: null,
      costPerOutputToken: null,
      metadataSourceName: "test",
      metadataSourceUrl: null,
    });
    const [usage] = await sql<{ id: string }[]>`
      INSERT INTO hive_models (
        hive_id,
        provider,
        adapter_type,
        model_id,
        model_catalog_id,
        enabled,
        owner_disabled_at,
        owner_disabled_reason
      )
      VALUES (
        ${HIVE_ID},
        'google',
        'gemini',
        'google/gemini-discovery-lock',
        ${catalogId},
        false,
        NOW(),
        'owner disabled'
      )
      RETURNING id
    `;

    const res = await PATCH(new Request("http://localhost/api/model-setup", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: HIVE_ID,
        modelCatalogId: catalogId,
        enabled: true,
        fallbackPriority: 12,
      }),
    }));

    const [row] = await sql<{
      enabled: boolean;
      owner_disabled_at: Date | null;
      owner_disabled_reason: string | null;
      fallback_priority: number;
    }[]>`
      SELECT enabled, owner_disabled_at, owner_disabled_reason, fallback_priority
      FROM hive_models
      WHERE id = ${usage.id}
    `;
    expect(res.status).toBe(200);
    expect(row.enabled).toBe(true);
    expect(row.owner_disabled_at).toBeNull();
    expect(row.owner_disabled_reason).toBeNull();
    expect(row.fallback_priority).toBe(12);
  });

  it("rejects credentials from a different hive", async () => {
    const catalogId = await upsertModelCatalogEntry(sql, {
      provider: "openai",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      displayName: "GPT-5.5",
      family: "gpt-5",
      capabilities: ["text", "code"],
      local: false,
      benchmarkQualityScore: 96,
      routingCostScore: 70,
      costPerInputToken: "0.000005",
      costPerOutputToken: "0.000030",
      metadataSourceName: "OpenAI pricing",
      metadataSourceUrl: "https://openai.com/api/pricing/",
    });

    const res = await PATCH(new Request("http://localhost/api/model-setup", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: HIVE_ID,
        modelCatalogId: catalogId,
        credentialId: OTHER_CREDENTIAL_ID,
      }),
    }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("credential must be global or belong to the selected hive");
  });

  it("rejects credentials from a different hive when updating an existing hive model", async () => {
    const catalogId = await upsertModelCatalogEntry(sql, {
      provider: "openai",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      displayName: "GPT-5.5",
      family: "gpt-5",
      capabilities: ["text", "code"],
      local: false,
      benchmarkQualityScore: 96,
      routingCostScore: 70,
      costPerInputToken: "0.000005",
      costPerOutputToken: "0.000030",
      metadataSourceName: "OpenAI pricing",
      metadataSourceUrl: "https://openai.com/api/pricing/",
    });
    const [usage] = await sql<{ id: string; credential_id: string | null }[]>`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        model_catalog_id,
        credential_id,
        enabled
      )
      VALUES (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', ${catalogId}, ${CREDENTIAL_ID}, true)
      RETURNING id, credential_id
    `;

    const res = await PATCH(new Request("http://localhost/api/model-setup", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: HIVE_ID,
        hiveModelId: usage.id,
        credentialId: OTHER_CREDENTIAL_ID,
      }),
    }));
    const body = await res.json();
    const [row] = await sql<{ credential_id: string | null }[]>`
      SELECT credential_id
      FROM hive_models
      WHERE id = ${usage.id}
    `;

    expect(res.status).toBe(400);
    expect(body.error).toBe("credential must be global or belong to the selected hive");
    expect(row.credential_id).toBe(CREDENTIAL_ID);
  });

  it("deletes a stale unreferenced catalog model", async () => {
    const catalogId = await upsertModelCatalogEntry(sql, {
      provider: "openai",
      adapterType: "codex",
      modelId: "openai-codex/gpt-stale",
      displayName: "GPT Stale",
      family: "gpt-5",
      capabilities: ["text", "code"],
      local: false,
      benchmarkQualityScore: 90,
      routingCostScore: 40,
      costPerInputToken: "0.000005",
      costPerOutputToken: "0.000030",
      metadataSourceName: "OpenAI pricing",
      metadataSourceUrl: "https://openai.com/api/pricing/",
    });
    await sql`UPDATE model_catalog SET stale_since = NOW() WHERE id = ${catalogId}`;

    const res = await DELETE(new Request("http://localhost/api/model-setup", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: HIVE_ID, modelCatalogId: catalogId }),
    }));
    const body = await res.json();
    const [row] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM model_catalog
      WHERE id = ${catalogId}
    `;

    expect(res.status).toBe(200);
    expect(body.data.deleted).toBe(true);
    expect(row.count).toBe("0");
  });

  it("rejects deletion of a fresh unreferenced catalog model", async () => {
    const catalogId = await upsertModelCatalogEntry(sql, {
      provider: "openai",
      adapterType: "codex",
      modelId: "openai-codex/gpt-fresh",
      displayName: "GPT Fresh",
      family: "gpt-5",
      capabilities: ["text", "code"],
      local: false,
      benchmarkQualityScore: 90,
      routingCostScore: 40,
      costPerInputToken: "0.000005",
      costPerOutputToken: "0.000030",
      metadataSourceName: "OpenAI pricing",
      metadataSourceUrl: "https://openai.com/api/pricing/",
    });

    const res = await DELETE(new Request("http://localhost/api/model-setup", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: HIVE_ID, modelCatalogId: catalogId }),
    }));
    const body = await res.json();
    const [row] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM model_catalog
      WHERE id = ${catalogId}
    `;

    expect(res.status).toBe(400);
    expect(body.error).toBe("model catalog row must be stale or deprecated before deletion");
    expect(row.count).toBe("1");
  });

  it("returns blockers instead of deleting a referenced catalog model", async () => {
    const catalogId = await upsertModelCatalogEntry(sql, {
      provider: "openai",
      adapterType: "codex",
      modelId: "openai-codex/gpt-blocked",
      displayName: "GPT Blocked",
      family: "gpt-5",
      capabilities: ["text", "code"],
      local: false,
      benchmarkQualityScore: 90,
      routingCostScore: 40,
      costPerInputToken: "0.000005",
      costPerOutputToken: "0.000030",
      metadataSourceName: "OpenAI pricing",
      metadataSourceUrl: "https://openai.com/api/pricing/",
    });
    await sql`UPDATE model_catalog SET stale_since = NOW() WHERE id = ${catalogId}`;
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        model_catalog_id,
        enabled
      )
      VALUES (${HIVE_ID}, 'openai', 'openai-codex/gpt-blocked', 'codex', ${catalogId}, false)
    `;

    const res = await DELETE(new Request("http://localhost/api/model-setup", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: HIVE_ID, modelCatalogId: catalogId }),
    }));
    const body = await res.json();
    const [row] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM model_catalog
      WHERE id = ${catalogId}
    `;

    expect(res.status).toBe(409);
    expect(body.error).toBe("model catalog row is still referenced");
    expect(body.data.blockers).toContain("hive_models");
    expect(row.count).toBe("1");
  });

  it("refreshes model metadata through the setup endpoint", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const href = url.toString();
      if (href.includes("openai.com/api/pricing")) {
        return textResponse("GPT-5.5 Input: $5.00 / 1M tokens Output: $30.00 / 1M tokens");
      }
      if (href.includes("anthropic.com/claude/opus")) {
        return textResponse("Pricing for Opus 4.7 starts at $5 per million input tokens and $25 per million output tokens.");
      }
      if (href.includes("ai.google.dev/gemini-api/docs/pricing")) {
        return textResponse("Gemini 3.1 Pro Input price $1.25 Output price $10.00 Gemini 3.1 Flash Lite Input price $0.25 Output price $1.50");
      }
      if (href.includes("artificialanalysis.ai")) {
        return textResponse("Qwen3 32B Intelligence Index 39 GPT-5.5 Intelligence Index 60");
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    await sql`
      INSERT INTO hive_models (hive_id, provider, model_id, adapter_type, enabled)
      VALUES (${HIVE_ID}, 'local', 'qwen3:32b', 'ollama', true)
    `;
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "local",
      adapterType: "ollama",
      baseUrl: null,
    });
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status)
      VALUES (${fingerprint}, 'qwen3:32b', 'healthy')
    `;

    const res = await refreshMetadata(new Request("http://localhost/api/model-setup/metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: HIVE_ID }),
    }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.result.hiveRowsUpdated).toBe(1);
  });
});

function textResponse(body: string) {
  return new Response(body, { status: 200 });
}
