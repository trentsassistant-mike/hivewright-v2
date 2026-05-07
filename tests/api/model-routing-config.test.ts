import { beforeEach, describe, expect, it } from "vitest";
import { GET, PATCH } from "../../src/app/api/model-routing/route";
import { upsertModelCapabilityScores } from "../../src/model-catalog/capability-scores";
import { createRuntimeCredentialFingerprint } from "../../src/model-health/probe-runner";
import { loadModelRoutingPolicy } from "../../src/model-routing/policy";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_ID = "bbbbbbbb-5555-4555-8555-bbbbbbbbbbbb";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'model-routing-config', 'Model Routing Config', 'digital')
  `;
});

describe("/api/model-routing", () => {
  it("saves preferences and overrides while returning registry-derived model rows", async () => {
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        cost_per_input_token,
        cost_per_output_token,
        benchmark_quality_score,
        routing_cost_score,
        enabled
      )
      VALUES (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', 0.000001, 0.000002, 96, 25, true)
    `;
    await upsertModelCapabilityScores(sql, [
      {
        modelCatalogId: null,
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-5.5",
        canonicalModelId: "openai-codex/gpt-5.5",
        axis: "coding",
        score: 35.6,
        rawScore: "35.6",
        source: "llm-stats",
        sourceUrl: "https://llm-stats.example/benchmarks",
        benchmarkName: "Coding Arena",
        modelVersionMatched: "GPT-5.5",
        confidence: "high",
      },
    ]);

    const policy = {
      preferences: {
        costQualityBalance: 68,
      },
      routeOverrides: {
        "openai:codex:openai-codex/gpt-5.5": {
          enabled: false,
          roleSlugs: ["dev-agent"],
          status: "healthy",
          qualityScore: 100,
        },
      },
      candidates: [
        {
          adapterType: "ollama",
          model: "unconfigured/free-text",
          qualityScore: 100,
          costScore: 0,
        },
      ],
    };

    const patchRes = await PATCH(new Request("http://localhost/api/model-routing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: HIVE_ID, policy }),
    }));
    const patchBody = await patchRes.json();

    expect(patchRes.status).toBe(200);
    expect(patchBody.data.policy.preferences).toEqual({ costQualityBalance: 68 });
    expect(patchBody.data.policy.routeOverrides).toEqual({
      "openai:codex:openai-codex/gpt-5.5": {
        enabled: false,
        roleSlugs: ["dev-agent"],
      },
    });
    expect(patchBody.data.policy.candidates).toHaveLength(1);
    expect(patchBody.data.policy.candidates[0]).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      enabled: false,
      qualityScore: 96,
      costScore: 25,
    });
    expect(patchBody.data.policy.candidates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "unconfigured/free-text",
        }),
      ]),
    );
    expect(patchBody.data.models[0]).toMatchObject({
      routeKey: "openai:codex:openai-codex/gpt-5.5",
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      routingEnabled: false,
      roleSlugs: ["dev-agent"],
      qualityScore: 96,
      costScore: 25,
      costPerInputToken: "0.000001000000",
      costPerOutputToken: "0.000002000000",
    });
    expect(patchBody.data.profiles.coding.weights.coding).toBeGreaterThan(0);
    expect(patchBody.data.models[0].capabilityScores).toEqual([
      expect.objectContaining({
        axis: "coding",
        score: 35.6,
        rawScore: "35.6",
        source: "llm-stats",
        sourceUrl: "https://llm-stats.example/benchmarks",
        benchmarkName: "Coding Arena",
        modelVersionMatched: "GPT-5.5",
        confidence: "high",
      }),
    ]);
    expect(patchBody.data.policy.candidates[0].capabilityScores).toEqual(
      patchBody.data.models[0].capabilityScores,
    );

    const loaded = await loadModelRoutingPolicy(sql, HIVE_ID);
    expect(loaded?.preferences).toEqual({ costQualityBalance: 68 });
    expect(loaded?.candidates).toEqual([]);
    expect(loaded?.routeOverrides?.["openai:codex:openai-codex/gpt-5.5"]?.enabled).toBe(false);

    const getRes = await GET(new Request(`http://localhost/api/model-routing?hiveId=${HIVE_ID}`));
    const getBody = await getRes.json();

    expect(getRes.status).toBe(200);
    expect(getBody.data.profiles.coding.weights.coding).toBeGreaterThan(0);
    expect(getBody.data.models).toHaveLength(1);
    expect(getBody.data.models[0].capabilityScores).toEqual([
      expect.objectContaining({
        axis: "coding",
        score: 35.6,
      }),
    ]);
    expect(getBody.data.policy.candidates).toHaveLength(1);
    expect(getBody.data.policy.candidates[0].model).toBe("openai-codex/gpt-5.5");
  });

  it("normalizes legacy routing weights to the cost quality slider preference", async () => {
    const patchRes = await PATCH(new Request("http://localhost/api/model-routing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: HIVE_ID,
        policy: {
          preferences: {
            minimumQualityScore: 70,
            qualityWeight: 1,
            costWeight: 5,
            localBonus: 10,
          },
          candidates: [],
        },
      }),
    }));
    const patchBody = await patchRes.json();

    expect(patchRes.status).toBe(200);
    expect(patchBody.data.policy.preferences).toEqual({ costQualityBalance: 17 });

    const loaded = await loadModelRoutingPolicy(sql, HIVE_ID);
    expect(loaded?.preferences).toEqual({ costQualityBalance: 17 });

    const [row] = await sql<{ config: { preferences?: unknown; candidates?: unknown } }[]>`
      SELECT config
      FROM adapter_config
      WHERE hive_id = ${HIVE_ID}
        AND adapter_type = 'model-routing'
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    expect(row?.config.preferences).toEqual({ costQualityBalance: 17 });
    expect(row?.config.preferences).not.toHaveProperty("minimumQualityScore");
    expect(row?.config.preferences).not.toHaveProperty("qualityWeight");
    expect(row?.config.preferences).not.toHaveProperty("costWeight");
    expect(row?.config.preferences).not.toHaveProperty("localBonus");
    expect(row?.config.candidates).toEqual([]);
  });

  it("does not let model routing saves enable disabled hive models as candidates", async () => {
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        benchmark_quality_score,
        routing_cost_score,
        enabled
      )
      VALUES (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', 96, 25, false)
    `;

    const patchRes = await PATCH(new Request("http://localhost/api/model-routing", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: HIVE_ID,
        policy: {
          routeOverrides: {
            "openai:codex:openai-codex/gpt-5.5": {
              enabled: true,
            },
          },
          candidates: [
            {
              adapterType: "codex",
              model: "openai-codex/gpt-5.5",
              enabled: true,
              qualityScore: 100,
              costScore: 0,
            },
          ],
        },
      }),
    }));
    const patchBody = await patchRes.json();

    expect(patchRes.status).toBe(200);
    expect(patchBody.data.models[0]).toMatchObject({
      routeKey: "openai:codex:openai-codex/gpt-5.5",
      hiveModelEnabled: false,
      routingEnabled: true,
    });
    expect(patchBody.data.policy.candidates[0]).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      enabled: false,
    });

    const loaded = await loadModelRoutingPolicy(sql, HIVE_ID);
    expect(loaded?.candidates).toEqual([]);
  });

  it("returns only the best capability score per axis in routing models and candidates", async () => {
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        benchmark_quality_score,
        routing_cost_score,
        enabled
      )
      VALUES (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', 96, 25, true)
    `;
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
        (NULL, 'openai', 'codex', 'openai-codex/gpt-5.5', 'openai-codex/gpt-5.5', 'coding', 33.3, '33.3', 'source-high-old', 'https://example.com/high-old', 'Coding Bench', 'GPT-5.5', 'high', '2026-01-01T00:00:00Z'),
        (NULL, 'openai', 'codex', 'openai-codex/gpt-5.5', 'openai-codex/gpt-5.5', 'coding', 44.4, '44.4', 'source-high-new', 'https://example.com/high-new', 'Coding Bench', 'GPT-5.5', 'high', '2026-01-02T00:00:00Z'),
        (NULL, 'openai', 'codex', 'openai-codex/gpt-5.5', 'openai-codex/gpt-5.5', 'coding', 55.5, '55.5', 'source-medium-newer', 'https://example.com/medium', 'Coding Bench', 'GPT-5.5', 'medium', '2026-01-03T00:00:00Z')
    `;

    const res = await GET(new Request(`http://localhost/api/model-routing?hiveId=${HIVE_ID}`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.models[0].capabilityScores).toEqual([
      expect.objectContaining({
        axis: "coding",
        score: 44.4,
        source: "source-high-new",
        confidence: "high",
      }),
    ]);
    expect(body.data.policy.candidates[0].capabilityScores).toEqual(
      body.data.models[0].capabilityScores,
    );
  });

  it("returns preview route explanations for preview task context", async () => {
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        benchmark_quality_score,
        routing_cost_score,
        enabled
      )
      VALUES (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', 96, 25, true)
    `;
    await upsertModelCapabilityScores(sql, [
      {
        modelCatalogId: null,
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-5.5",
        canonicalModelId: "openai-codex/gpt-5.5",
        axis: "coding",
        score: 45,
        rawScore: "45",
        source: "llm-stats",
        sourceUrl: "https://llm-stats.example/benchmarks",
        benchmarkName: "Coding Arena",
        modelVersionMatched: "GPT-5.5",
        confidence: "high",
      },
      {
        modelCatalogId: null,
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-5.5",
        canonicalModelId: "openai-codex/gpt-5.5",
        axis: "reasoning",
        score: 80,
        rawScore: "80",
        source: "llm-stats",
        sourceUrl: "https://llm-stats.example/benchmarks",
        benchmarkName: "Reasoning",
        modelVersionMatched: "GPT-5.5",
        confidence: "high",
      },
      {
        modelCatalogId: null,
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-5.5",
        canonicalModelId: "openai-codex/gpt-5.5",
        axis: "tool_use",
        score: 70,
        rawScore: "70",
        source: "llm-stats",
        sourceUrl: "https://llm-stats.example/benchmarks",
        benchmarkName: "Tools",
        modelVersionMatched: "GPT-5.5",
        confidence: "high",
      },
      {
        modelCatalogId: null,
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-5.5",
        canonicalModelId: "openai-codex/gpt-5.5",
        axis: "speed",
        score: 70,
        rawScore: "70",
        source: "llm-stats",
        sourceUrl: "https://llm-stats.example/benchmarks",
        benchmarkName: "Speed",
        modelVersionMatched: "GPT-5.5",
        confidence: "high",
      },
    ]);
    await sql`
      INSERT INTO model_health (
        fingerprint,
        model_id,
        status,
        last_probed_at
      )
      VALUES (
        ${createRuntimeCredentialFingerprint({
          provider: "openai",
          adapterType: "codex",
          baseUrl: null,
        })},
        'openai-codex/gpt-5.5',
        'healthy',
        now()
      )
    `;

    const previewRes = await GET(new Request(
      `http://localhost/api/model-routing?hiveId=${HIVE_ID}&previewTitle=Implement%20tests&previewBrief=Write%20TypeScript%20code`,
    ));
    const previewBody = await previewRes.json();

    expect(previewRes.status).toBe(200);
    expect(previewBody.data.previewRoute).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      profile: "coding",
    });
    expect(previewBody.data.previewRoute.explanation).toContain("coding");

    const acceptancePreviewRes = await GET(new Request(
      `http://localhost/api/model-routing?hiveId=${HIVE_ID}&previewTitle=Draft%20docs&previewBrief=Write%20release%20copy&previewAcceptanceCriteria=TypeScript%20tests%20pass`,
    ));
    const acceptancePreviewBody = await acceptancePreviewRes.json();

    expect(acceptancePreviewRes.status).toBe(200);
    expect(acceptancePreviewBody.data.previewRoute).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      profile: "coding",
    });

    const regularRes = await GET(
      new Request(`http://localhost/api/model-routing?hiveId=${HIVE_ID}`),
    );
    const regularBody = await regularRes.json();

    expect(regularRes.status).toBe(200);
    expect(regularBody.data.previewRoute).toBeNull();
  });
});
