import { beforeEach, describe, expect, it } from "vitest";
import { upsertModelCapabilityScores } from "@/model-catalog/capability-scores";
import { refreshModelCatalogMetadata } from "@/model-catalog/catalog";
import {
  buildLiveModelCapabilityScores,
  buildLiveModelCatalogEntries,
} from "@/model-catalog/metadata-sources";
import { testSql as sql, truncateAll } from "../_lib/test-db";

beforeEach(async () => {
  await truncateAll(sql);
});

async function createHive(slug: string): Promise<string> {
  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type)
    VALUES (${slug}, ${slug}, 'digital')
    RETURNING id
  `;
  return hive.id;
}

describe("model catalog capability scores", () => {
  it("extracts BenchLM benchmark quality and categories for dynamic catalog targets", async () => {
    const targets = [
      {
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-5.4-pro",
        displayName: "gpt-5.4-pro",
        family: "gpt-5",
        capabilities: ["text", "code", "reasoning"],
        local: false,
      },
    ];
    const benchLm = JSON.stringify({
      lastUpdated: "May 1, 2026",
      models: [
        {
          model: "GPT-5.4 Pro",
          creator: "OpenAI",
          overallScore: 91,
          categoryScores: {
            reasoning: 92,
            coding: 89,
            math: 87,
            agentic: 94,
            multimodalGrounded: 77,
          },
        },
      ],
    });

    const fetchImpl = async (url: string | URL) => {
      const href = String(url);
      return new Response(href.includes("benchlm.ai/api/data/leaderboard") ? benchLm : "");
    };

    const entries = await buildLiveModelCatalogEntries(fetchImpl, targets);
    const targetEntry = entries.find((entry) => entry.modelId === "openai-codex/gpt-5.4-pro");
    const scores = await buildLiveModelCapabilityScores(fetchImpl, targets);

    expect(targetEntry).toMatchObject({
      benchmarkQualityScore: 91,
      metadataSourceName: "BenchLM leaderboard",
      metadataSourceUrl: "https://benchlm.ai/api/data/leaderboard?limit=300",
    });
    expect(scores).toContainEqual(expect.objectContaining({
      provider: "openai",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.4-pro",
      axis: "coding",
      score: 89,
      source: "BenchLM",
      benchmarkName: "coding",
      modelVersionMatched: "GPT-5.4 Pro",
      confidence: "high",
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "openai-codex/gpt-5.4-pro",
      axis: "tool_use",
      score: 94,
      benchmarkName: "agentic",
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "openai-codex/gpt-5.4-pro",
      axis: "vision",
      score: 77,
      benchmarkName: "multimodalGrounded",
    }));
  });

  it("does not apply BenchLM scores when the model name matches a different provider", async () => {
    const targets = [
      {
        provider: "google",
        adapterType: "gemini",
        modelId: "google/gpt-5.4-pro",
        displayName: "GPT-5.4 Pro",
        family: "gemini",
        capabilities: ["text", "code", "reasoning"],
        local: false,
      },
    ];
    const benchLm = JSON.stringify({
      models: [
        {
          model: "GPT-5.4 Pro",
          creator: "OpenAI",
          overallScore: 91,
          categoryScores: { coding: 89 },
        },
      ],
    });
    const fetchImpl = async (url: string | URL) => {
      const href = String(url);
      return new Response(href.includes("benchlm.ai/api/data/leaderboard") ? benchLm : "");
    };

    const entries = await buildLiveModelCatalogEntries(fetchImpl, targets);
    const targetEntry = entries.find((entry) => entry.modelId === "google/gpt-5.4-pro");
    const scores = await buildLiveModelCapabilityScores(fetchImpl, targets);

    expect(targetEntry?.benchmarkQualityScore).toBeNull();
    expect(scores).not.toContainEqual(expect.objectContaining({
      modelId: "google/gpt-5.4-pro",
      source: "BenchLM",
    }));
  });

  it("matches short OpenAI ids and Claude dotted version aliases from BenchLM", async () => {
    const targets = [
      {
        provider: "openai",
        adapterType: "codex",
        modelId: "o3",
        displayName: "o3",
        family: "o3",
        capabilities: ["text", "reasoning"],
        local: false,
      },
      {
        provider: "anthropic",
        adapterType: "claude-code",
        modelId: "anthropic/claude-opus-4-5",
        displayName: "Claude Opus 4 5",
        family: "claude-opus",
        capabilities: ["text", "reasoning"],
        local: false,
      },
    ];
    const benchLm = JSON.stringify({
      models: [
        {
          model: "o3",
          creator: "OpenAI",
          overallScore: 58,
          categoryScores: { reasoning: 65 },
        },
        {
          model: "Claude Opus 4.5",
          creator: "Anthropic",
          overallScore: 87,
          categoryScores: { coding: 82 },
        },
      ],
    });
    const fetchImpl = async (url: string | URL) => {
      const href = String(url);
      return new Response(href.includes("benchlm.ai/api/data/leaderboard") ? benchLm : "");
    };

    const entries = await buildLiveModelCatalogEntries(fetchImpl, targets);
    const scores = await buildLiveModelCapabilityScores(fetchImpl, targets);

    expect(entries).toContainEqual(expect.objectContaining({
      modelId: "o3",
      benchmarkQualityScore: 58,
    }));
    expect(entries).toContainEqual(expect.objectContaining({
      modelId: "anthropic/claude-opus-4-5",
      benchmarkQualityScore: 87,
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "o3",
      axis: "reasoning",
      score: 65,
      modelVersionMatched: "o3",
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "anthropic/claude-opus-4-5",
      axis: "coding",
      score: 82,
      modelVersionMatched: "Claude Opus 4.5",
    }));
  });

  it("extracts category scores for Ollama-hosted models using benchmark aliases", async () => {
    const targets = [
      {
        provider: "local",
        adapterType: "ollama",
        modelId: "ollama/qwen3:32b",
        displayName: "qwen3:32b",
        family: "qwen",
        capabilities: ["text", "code"],
        local: true,
      },
    ];
    const leaderboard = `
Model Country License Context Input $/M Output $/M Speed Code Arena Reasoning Math Coding Search Writing Vision Tools Long Ctx Finance Legal Health
Qwen3 32B Open 40k $0.00 $0.00 75 c/s 920 44.2 59.4 61.5 - 42.0 - 38.0 35.0 - - -
`;

    const scores = await buildLiveModelCapabilityScores(async (url) => {
      const href = String(url);
      return new Response(href.includes("/leaderboards/llm-leaderboard") ? leaderboard : "");
    }, targets);

    expect(scores).toContainEqual(expect.objectContaining({
      provider: "local",
      adapterType: "ollama",
      modelId: "ollama/qwen3:32b",
      canonicalModelId: "ollama/qwen3:32b",
      axis: "coding",
      score: 61.5,
      source: "LLM Stats",
      modelVersionMatched: "Qwen3 32B",
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "ollama/qwen3:32b",
      axis: "math",
      score: 59.4,
    }));
  });

  it("extracts category scores for Ollama-hosted models from LLM Stats embedded JSON", async () => {
    const targets = [
      {
        provider: "local",
        adapterType: "ollama",
        modelId: "ollama/qwen3:32b",
        displayName: "qwen3:32b",
        family: "qwen",
        capabilities: ["text", "code"],
        local: true,
      },
    ];
    const leaderboard = `
      <script>
        self.__next_f.push([1,"{\\"model_id\\":\\"qwen3-32b\\",\\"name\\":\\"Qwen3 32B\\",\\"throughput\\":193.18,\\"index_reasoning\\":18.91,\\"index_math\\":22.49,\\"index_code\\":13.11,\\"index_tool_calling\\":19.56}"])
      </script>
    `;

    const scores = await buildLiveModelCapabilityScores(async (url) => {
      const href = String(url);
      return new Response(href.includes("/leaderboards/llm-leaderboard") ? leaderboard : "");
    }, targets);

    expect(scores).toContainEqual(expect.objectContaining({
      provider: "local",
      adapterType: "ollama",
      modelId: "ollama/qwen3:32b",
      canonicalModelId: "ollama/qwen3:32b",
      axis: "coding",
      score: 13.11,
      rawScore: "13.11",
      source: "LLM Stats",
      benchmarkName: "Code Index",
      modelVersionMatched: "Qwen3 32B",
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "ollama/qwen3:32b",
      axis: "tool_use",
      score: 19.56,
      benchmarkName: "Tool Calling Index",
    }));
  });

  it("extracts LLM Stats capability axes from the full leaderboard", async () => {
    const leaderboard = `
Model Country License Context Input $/M Output $/M Speed Code Arena Reasoning Math Coding Search Writing Vision Tools Long Ctx Finance Legal Health
GPT-5.5 Closed 1.1M $5.00 $30.00 124 c/s 1,267 62.9 48.5 53.1 35.6 30.8 46.9 40.4 30.5 21.8 74.0 58.6
Claude Sonnet 4.6 Closed 200k $3.00 $15.00 201 c/s 1,423 52.6 44.3 37.7 24.8 - 34.0 29.8 26.3 41.6 72.5 49.0
`;

    const scores = await buildLiveModelCapabilityScores(async () => new Response(leaderboard));

    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "openai-codex/gpt-5.5",
      axis: "reasoning",
      score: 62.9,
      rawScore: "62.9",
      benchmarkName: "Reasoning",
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "openai-codex/gpt-5.5",
      axis: "math",
      score: 48.5,
      rawScore: "48.5",
      benchmarkName: "Math",
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "openai-codex/gpt-5.5",
      axis: "coding",
      score: 53.1,
      rawScore: "53.1",
      benchmarkName: "Coding",
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "openai-codex/gpt-5.5",
      axis: "search",
      score: 35.6,
      rawScore: "35.6",
      benchmarkName: "Search",
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelCatalogId: null,
      provider: "openai",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      canonicalModelId: "openai-codex/gpt-5.5",
      axis: "writing",
      score: 30.8,
      rawScore: "30.8",
      source: "LLM Stats",
      sourceUrl: "https://llm-stats.com/leaderboards/llm-leaderboard",
      benchmarkName: "Writing",
      modelVersionMatched: "GPT-5.5",
      confidence: "high",
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "openai-codex/gpt-5.5",
      axis: "vision",
      score: 46.9,
      rawScore: "46.9",
      benchmarkName: "Vision",
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "openai-codex/gpt-5.5",
      axis: "tool_use",
      score: 40.4,
      rawScore: "40.4",
      benchmarkName: "Tools",
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "openai-codex/gpt-5.5",
      axis: "long_context",
      score: 30.5,
      rawScore: "30.5",
      benchmarkName: "Long Ctx",
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "openai-codex/gpt-5.5",
      axis: "finance",
      score: 21.8,
      rawScore: "21.8",
      benchmarkName: "Finance",
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "openai-codex/gpt-5.5",
      axis: "legal",
      score: 74.0,
      rawScore: "74.0",
      benchmarkName: "Legal",
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "openai-codex/gpt-5.5",
      axis: "health_medical",
      score: 58.6,
      rawScore: "58.6",
      benchmarkName: "Health",
    }));
    expect(scores).toContainEqual(expect.objectContaining({
      modelId: "anthropic/claude-sonnet-4-6",
      axis: "health_medical",
      score: 49.0,
      rawScore: "49.0",
      benchmarkName: "Health",
    }));
    expect(scores).not.toContainEqual(expect.objectContaining({
      modelId: "anthropic/claude-sonnet-4-6",
      axis: "writing",
    }));
  });

  it("persists benchmark capability scores with provenance", async () => {
    const [catalog] = await sql<{ id: string }[]>`
      INSERT INTO model_catalog (
        provider,
        adapter_type,
        model_id,
        display_name,
        capabilities,
        local
      )
      VALUES (
        'openai',
        'codex',
        'openai-codex/gpt-5.5',
        'GPT-5.5',
        ${sql.json(["text", "writing"])},
        false
      )
      RETURNING id
    `;

    const upserted = await upsertModelCapabilityScores(sql, [
      {
        modelCatalogId: catalog.id,
        provider: "openai",
        adapterType: "codex",
        modelId: "openai-codex/gpt-5.5",
        canonicalModelId: "openai-codex/gpt-5.5",
        axis: "writing",
        score: 46.9,
        rawScore: "46.9",
        source: "LLM Stats",
        sourceUrl: "https://llm-stats.com/",
        benchmarkName: "LLM Stats Writing",
        modelVersionMatched: "gpt-5.5",
        confidence: "high",
      },
    ]);

    expect(upserted).toBe(1);

    const [row] = await sql<{
      model_catalog_id: string | null;
      provider: string;
      adapter_type: string;
      model_id: string;
      canonical_model_id: string;
      axis: string;
      score: string;
      raw_score: string | null;
      source: string;
      source_url: string;
      benchmark_name: string;
      model_version_matched: string;
      confidence: string;
    }[]>`
      SELECT
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
        confidence
      FROM model_capability_scores
      WHERE provider = 'openai'
        AND adapter_type = 'codex'
        AND canonical_model_id = 'openai-codex/gpt-5.5'
        AND axis = 'writing'
        AND source = 'LLM Stats'
        AND benchmark_name = 'LLM Stats Writing'
    `;

    expect(row).toMatchObject({
      model_catalog_id: catalog.id,
      provider: "openai",
      adapter_type: "codex",
      model_id: "openai-codex/gpt-5.5",
      canonical_model_id: "openai-codex/gpt-5.5",
      axis: "writing",
      score: "46.90",
      raw_score: "46.9",
      source: "LLM Stats",
      source_url: "https://llm-stats.com/",
      benchmark_name: "LLM Stats Writing",
      model_version_matched: "gpt-5.5",
      confidence: "high",
    });
  });

  it("preserves an existing catalog link when an incoming score has no catalog id", async () => {
    const [catalog] = await sql<{ id: string }[]>`
      INSERT INTO model_catalog (
        provider,
        adapter_type,
        model_id,
        display_name,
        capabilities,
        local
      )
      VALUES (
        'openai',
        'codex',
        'openai-codex/gpt-5.5',
        'GPT-5.5',
        ${sql.json(["text", "writing"])},
        false
      )
      RETURNING id
    `;

    const score = {
      modelCatalogId: catalog.id,
      provider: "openai",
      adapterType: "codex",
      modelId: "openai-codex/gpt-5.5",
      canonicalModelId: "openai-codex/gpt-5.5",
      axis: "writing" as const,
      score: 46.9,
      rawScore: "46.9",
      source: "LLM Stats",
      sourceUrl: "https://llm-stats.com/",
      benchmarkName: "LLM Stats Writing",
      modelVersionMatched: "gpt-5.5",
      confidence: "high" as const,
    };

    await upsertModelCapabilityScores(sql, [score]);
    await upsertModelCapabilityScores(sql, [
      {
        ...score,
        modelCatalogId: null,
        score: 47.25,
        rawScore: "47.25",
      },
    ]);

    const [row] = await sql<{ model_catalog_id: string | null; score: string }[]>`
      SELECT model_catalog_id, score
      FROM model_capability_scores
      WHERE provider = 'openai'
        AND adapter_type = 'codex'
        AND canonical_model_id = 'openai-codex/gpt-5.5'
        AND axis = 'writing'
        AND source = 'LLM Stats'
        AND benchmark_name = 'LLM Stats Writing'
    `;

    expect(row).toEqual({
      model_catalog_id: catalog.id,
      score: "47.25",
    });
  });

  it("persists supplied capability scores during metadata refresh", async () => {
    const result = await refreshModelCatalogMetadata(sql, {
      fetchLiveMetadata: false,
      metadataEntries: [
        {
          provider: "openai",
          adapterType: "codex",
          modelId: "openai-codex/gpt-5.5",
          displayName: "GPT-5.5",
          family: "gpt-5",
          capabilities: ["text", "code", "reasoning"],
          local: false,
          costPerInputToken: "0.000005",
          costPerOutputToken: "0.000030",
          benchmarkQualityScore: 96,
          routingCostScore: 70,
          metadataSourceName: "OpenAI API pricing",
          metadataSourceUrl: "https://openai.com/api/pricing/",
        },
      ],
      capabilityScores: [
        {
          modelCatalogId: null,
          provider: "openai",
          adapterType: "codex",
          modelId: "gpt-5.5",
          canonicalModelId: "stale-canonical-id",
          axis: "coding",
          score: 35.6,
          rawScore: "35.6",
          source: "LLM Stats",
          sourceUrl: "https://llm-stats.com/leaderboards/llm-leaderboard",
          benchmarkName: "Coding",
          modelVersionMatched: "GPT-5.5",
          confidence: "high",
        },
      ],
    });

    expect(result).toEqual(expect.objectContaining({ capabilityScoreCount: 1 }));

    const [row] = await sql<{ model_catalog_id: string | null; canonical_model_id: string; axis: string; score: string }[]>`
      SELECT model_catalog_id, canonical_model_id, axis, score
      FROM model_capability_scores
      WHERE provider = 'openai'
        AND adapter_type = 'codex'
        AND canonical_model_id = 'openai-codex/gpt-5.5'
        AND axis = 'coding'
    `;

    expect(row).toMatchObject({
      canonical_model_id: "openai-codex/gpt-5.5",
      axis: "coding",
      score: "35.60",
    });
    expect(row.model_catalog_id).toEqual(expect.any(String));
  });

  it("persists live capability scores during metadata refresh", async () => {
    const leaderboard = `
Model Country License Context Input $/M Output $/M Speed Code Arena Reasoning Math Coding Search Writing Vision Tools Long Ctx Finance Legal Health
GPT-5.5 Closed 1.1M $5.00 $30.00 124 c/s 1,267 62.9 48.5 53.1 35.6 30.8 46.9 40.4 30.5 21.8 74.0 58.6
`;

    const result = await refreshModelCatalogMetadata(sql, {
      fetchLiveMetadata: true,
      metadataEntries: [
        {
          provider: "openai",
          adapterType: "codex",
          modelId: "openai-codex/gpt-5.5",
          displayName: "GPT-5.5",
          family: "gpt-5",
          capabilities: ["text", "code", "reasoning"],
          local: false,
          costPerInputToken: "0.000005",
          costPerOutputToken: "0.000030",
          benchmarkQualityScore: 96,
          routingCostScore: 70,
          metadataSourceName: "OpenAI API pricing",
          metadataSourceUrl: "https://openai.com/api/pricing/",
        },
      ],
      fetchImpl: async (url) => {
        const href = String(url);
        return new Response(href.includes("/leaderboards/llm-leaderboard") ? leaderboard : "");
      },
    });

    expect(result.capabilityScoreCount).toBeGreaterThan(0);

    const [row] = await sql<{ model_catalog_id: string | null; axis: string; score: string }[]>`
      SELECT model_catalog_id, axis, score
      FROM model_capability_scores
      WHERE provider = 'openai'
        AND adapter_type = 'codex'
        AND canonical_model_id = 'openai-codex/gpt-5.5'
        AND axis = 'coding'
    `;

    expect(row).toMatchObject({
      model_catalog_id: expect.any(String),
      axis: "coding",
      score: "53.10",
    });
  });

  it("does not fill estimated routing metadata for discovered cloud models outside the curated list", async () => {
    const hiveId = await createHive("catalog-discovered-metadata");
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        adapter_type,
        model_id,
        enabled,
        auto_discovered
      )
      VALUES (
        ${hiveId},
        'openai',
        'codex',
        'openai-codex/gpt-5.6-mini',
        true,
        true
      )
    `;
    await sql`
      INSERT INTO model_catalog (
        provider,
        adapter_type,
        model_id,
        display_name,
        family,
        capabilities,
        local,
        discovery_source
      )
      VALUES (
        'openai',
        'codex',
        'openai-codex/gpt-5.6-mini',
        'GPT 5.6 Mini',
        'gpt-5',
        ${sql.json(["text", "code", "reasoning"])},
        false,
        'openai_public_model_docs'
      )
    `;

    const result = await refreshModelCatalogMetadata(sql, {
      hiveId,
      fetchLiveMetadata: false,
    });

    const [row] = await sql<{
      cost_per_input_token: string | null;
      cost_per_output_token: string | null;
      benchmark_quality_score: string | null;
      routing_cost_score: string | null;
      metadata_source_name: string | null;
      metadata_source_url: string | null;
    }[]>`
      SELECT
        hm.cost_per_input_token,
        hm.cost_per_output_token,
        hm.benchmark_quality_score,
        hm.routing_cost_score,
        mc.metadata_source_name,
        mc.metadata_source_url
      FROM hive_models hm
      JOIN model_catalog mc ON mc.id = hm.model_catalog_id
      WHERE hm.hive_id = ${hiveId}
        AND hm.model_id = 'openai-codex/gpt-5.6-mini'
    `;

    expect(result.hiveRowsLinked).toBeGreaterThan(0);
    expect(row.cost_per_input_token).toBeNull();
    expect(row.cost_per_output_token).toBeNull();
    expect(row.benchmark_quality_score).toBeNull();
    expect(row.routing_cost_score).toBeNull();
    expect(row.metadata_source_name).toBeNull();
    expect(row.metadata_source_url).toBeNull();
  });

  it("counts linked models with no numeric metadata as missing metadata", async () => {
    const hiveId = await createHive("catalog-counts-missing-numeric-metadata");
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        adapter_type,
        model_id,
        enabled,
        auto_discovered
      )
      VALUES (
        ${hiveId},
        'openai',
        'codex',
        'openai-codex/gpt-5.6-mini',
        true,
        true
      )
    `;
    await sql`
      INSERT INTO model_catalog (
        provider,
        adapter_type,
        model_id,
        display_name,
        family,
        capabilities,
        local,
        metadata_source_name,
        metadata_source_url,
        discovery_source
      )
      VALUES (
        'openai',
        'codex',
        'openai-codex/gpt-5.6-mini',
        'GPT 5.6 Mini',
        'gpt-5',
        ${sql.json(["text", "code", "reasoning"])},
        false,
        'OpenAI public model docs',
        'https://developers.openai.com/api/docs/models/all/',
        'openai_public_model_docs'
      )
    `;

    const result = await refreshModelCatalogMetadata(sql, {
      hiveId,
      fetchLiveMetadata: false,
    });

    expect(result.hiveRowsLinked).toBeGreaterThan(0);
    expect(result.missingMetadata).toBeGreaterThan(0);
  });

  it("does not count linked models with capability scores as missing metadata", async () => {
    const hiveId = await createHive("catalog-counts-capability-scores-as-metadata");
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        adapter_type,
        model_id,
        enabled,
        auto_discovered
      )
      VALUES (
        ${hiveId},
        'openai',
        'codex',
        'openai-codex/gpt-5-mini',
        true,
        true
      )
    `;
    await sql`
      INSERT INTO model_catalog (
        provider,
        adapter_type,
        model_id,
        display_name,
        family,
        capabilities,
        local,
        metadata_source_name,
        metadata_source_url,
        discovery_source
      )
      VALUES (
        'openai',
        'codex',
        'openai-codex/gpt-5-mini',
        'GPT-5 Mini',
        'gpt-5',
        ${sql.json(["text", "code", "reasoning"])},
        false,
        'OpenAI public model docs',
        'https://developers.openai.com/api/docs/models/all/',
        'openai_public_model_docs'
      )
    `;

    const result = await refreshModelCatalogMetadata(sql, {
      hiveId,
      fetchLiveMetadata: false,
      capabilityScores: [
        {
          modelCatalogId: null,
          provider: "openai",
          adapterType: "codex",
          modelId: "openai-codex/gpt-5-mini",
          canonicalModelId: "openai-codex/gpt-5-mini",
          axis: "coding",
          score: 52,
          rawScore: "52",
          source: "LLM Stats",
          sourceUrl: "https://llm-stats.com/leaderboards/llm-leaderboard",
          benchmarkName: "Code Index",
          modelVersionMatched: "GPT-5 Mini",
          confidence: "high",
        },
      ],
    });

    expect(result.hiveRowsLinked).toBeGreaterThan(0);
    expect(result.missingMetadata).toBe(0);
  });

  it("does not count local zero-cost metadata as missing metadata", async () => {
    const hiveId = await createHive("catalog-counts-local-zero-cost-metadata");
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        adapter_type,
        model_id,
        enabled,
        auto_discovered
      )
      VALUES (
        ${hiveId},
        'local',
        'ollama',
        'ollama/qwen3:32b',
        true,
        true
      )
    `;

    const result = await refreshModelCatalogMetadata(sql, {
      hiveId,
      fetchLiveMetadata: false,
    });

    expect(result.hiveRowsLinked).toBeGreaterThan(0);
    expect(result.missingMetadata).toBe(0);
  });

  it("retires auto-discovered models that still have no real benchmark data after live refresh", async () => {
    const hiveId = await createHive("catalog-retire-unbenchmarked-discovered-models");
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        adapter_type,
        model_id,
        enabled,
        auto_discovered
      )
      VALUES (
        ${hiveId},
        'openai',
        'codex',
        'openai-codex/gpt-unbenchmarked',
        true,
        true
      )
    `;
    await sql`
      INSERT INTO model_catalog (
        provider,
        adapter_type,
        model_id,
        display_name,
        family,
        capabilities,
        local,
        metadata_source_name,
        metadata_source_url,
        discovery_source
      )
      VALUES (
        'openai',
        'codex',
        'openai-codex/gpt-unbenchmarked',
        'GPT Unbenchmarked',
        'gpt',
        ${sql.json(["text", "code", "reasoning"])},
        false,
        'OpenAI public model docs',
        'https://developers.openai.com/api/docs/models/all/',
        'openai_public_model_docs'
      )
    `;

    const result = await refreshModelCatalogMetadata(sql, {
      hiveId,
      fetchLiveMetadata: true,
      fetchImpl: async () => new Response(""),
    });

    const [hiveRow] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM hive_models
      WHERE hive_id = ${hiveId}
        AND model_id = 'openai-codex/gpt-unbenchmarked'
    `;
    const [catalogRow] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM model_catalog
      WHERE model_id = 'openai-codex/gpt-unbenchmarked'
    `;

    expect(result.missingMetadata).toBe(0);
    expect(hiveRow.count).toBe("0");
    expect(catalogRow.count).toBe("0");
  });

  it("keeps auto-discovered models when real benchmark data exists", async () => {
    const hiveId = await createHive("catalog-keeps-benchmarked-discovered-models");
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        adapter_type,
        model_id,
        enabled,
        auto_discovered
      )
      VALUES (
        ${hiveId},
        'openai',
        'codex',
        'openai-codex/gpt-5.4-pro',
        true,
        true
      )
    `;
    await sql`
      INSERT INTO model_catalog (
        provider,
        adapter_type,
        model_id,
        display_name,
        family,
        capabilities,
        local,
        metadata_source_name,
        metadata_source_url,
        discovery_source
      )
      VALUES (
        'openai',
        'codex',
        'openai-codex/gpt-5.4-pro',
        'gpt-5.4-pro',
        'gpt',
        ${sql.json(["text", "code", "reasoning"])},
        false,
        'OpenAI public model docs',
        'https://developers.openai.com/api/docs/models/all/',
        'openai_public_model_docs'
      )
    `;
    const benchLm = JSON.stringify({
      models: [
        {
          model: "GPT-5.4 Pro",
          creator: "OpenAI",
          overallScore: 91,
          categoryScores: { coding: 89 },
        },
      ],
    });

    await refreshModelCatalogMetadata(sql, {
      hiveId,
      fetchLiveMetadata: true,
      fetchImpl: async (url) => {
        const href = String(url);
        return new Response(href.includes("benchlm.ai/api/data/leaderboard") ? benchLm : "");
      },
    });

    const [hiveRow] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM hive_models
      WHERE hive_id = ${hiveId}
        AND model_id = 'openai-codex/gpt-5.4-pro'
    `;
    const [catalogRow] = await sql<{ benchmark_quality_score: string | null }[]>`
      SELECT benchmark_quality_score
      FROM model_catalog
      WHERE model_id = 'openai-codex/gpt-5.4-pro'
    `;

    expect(hiveRow.count).toBe("1");
    expect(catalogRow.benchmark_quality_score).toBe("91.00");
  });

  it("clears previously estimated routing metadata during refresh", async () => {
    const hiveId = await createHive("catalog-clear-estimated-metadata");
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        adapter_type,
        model_id,
        cost_per_input_token,
        cost_per_output_token,
        benchmark_quality_score,
        routing_cost_score,
        enabled,
        auto_discovered
      )
      VALUES (
        ${hiveId},
        'openai',
        'codex',
        'openai-codex/gpt-5.6-mini',
        0.000000750000,
        0.000004000000,
        84,
        10,
        true,
        true
      )
    `;
    await sql`
      INSERT INTO model_catalog (
        provider,
        adapter_type,
        model_id,
        display_name,
        family,
        capabilities,
        local,
        cost_per_input_token,
        cost_per_output_token,
        benchmark_quality_score,
        routing_cost_score,
        metadata_source_name,
        metadata_source_url,
        discovery_source
      )
      VALUES (
        'openai',
        'codex',
        'openai-codex/gpt-5.6-mini',
        'GPT 5.6 Mini',
        'gpt-5',
        ${sql.json(["text", "code", "reasoning"])},
        false,
        0.000000750000,
        0.000004000000,
        84,
        10,
        'Estimated metadata from discovered model family',
        'https://developers.openai.com/api/docs/models/all/',
        'openai_public_model_docs'
      )
    `;

    await refreshModelCatalogMetadata(sql, {
      hiveId,
      fetchLiveMetadata: false,
    });

    const [row] = await sql<{
      catalog_cost_per_input_token: string | null;
      catalog_cost_per_output_token: string | null;
      catalog_benchmark_quality_score: string | null;
      catalog_routing_cost_score: string | null;
      hive_cost_per_input_token: string | null;
      hive_cost_per_output_token: string | null;
      hive_benchmark_quality_score: string | null;
      hive_routing_cost_score: string | null;
      metadata_source_name: string | null;
      metadata_source_url: string | null;
    }[]>`
      SELECT
        mc.cost_per_input_token AS catalog_cost_per_input_token,
        mc.cost_per_output_token AS catalog_cost_per_output_token,
        mc.benchmark_quality_score AS catalog_benchmark_quality_score,
        mc.routing_cost_score AS catalog_routing_cost_score,
        hm.cost_per_input_token AS hive_cost_per_input_token,
        hm.cost_per_output_token AS hive_cost_per_output_token,
        hm.benchmark_quality_score AS hive_benchmark_quality_score,
        hm.routing_cost_score AS hive_routing_cost_score,
        mc.metadata_source_name,
        mc.metadata_source_url
      FROM hive_models hm
      JOIN model_catalog mc ON mc.id = hm.model_catalog_id
      WHERE hm.hive_id = ${hiveId}
        AND hm.model_id = 'openai-codex/gpt-5.6-mini'
    `;

    expect(row).toMatchObject({
      catalog_cost_per_input_token: null,
      catalog_cost_per_output_token: null,
      catalog_benchmark_quality_score: null,
      catalog_routing_cost_score: null,
      hive_cost_per_input_token: null,
      hive_cost_per_output_token: null,
      hive_benchmark_quality_score: null,
      hive_routing_cost_score: null,
      metadata_source_name: null,
      metadata_source_url: null,
    });
  });

  it("clears public-doc numeric metadata and local benchmark estimates without clearing local costs", async () => {
    const hiveId = await createHive("catalog-clear-public-doc-and-local-metadata");
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        adapter_type,
        model_id,
        cost_per_input_token,
        cost_per_output_token,
        benchmark_quality_score,
        routing_cost_score,
        enabled,
        auto_discovered
      )
      VALUES
        (
          ${hiveId},
          'google',
          'gemini',
          'google/gemini-3.1-pro',
          0.000001250000,
          0.000010000000,
          84,
          23,
          true,
          true
        ),
        (
          ${hiveId},
          'local',
          'ollama',
          'ollama/qwen3:32b',
          0,
          0,
          82,
          0,
          true,
          true
        )
    `;
    await sql`
      INSERT INTO model_catalog (
        provider,
        adapter_type,
        model_id,
        display_name,
        family,
        capabilities,
        local,
        cost_per_input_token,
        cost_per_output_token,
        benchmark_quality_score,
        routing_cost_score,
        metadata_source_name,
        metadata_source_url,
        discovery_source
      )
      VALUES
        (
          'google',
          'gemini',
          'google/gemini-3.1-pro',
          'Gemini 3.1 Pro',
          'gemini',
          ${sql.json(["text", "code", "reasoning"])},
          false,
          0.000001250000,
          0.000010000000,
          84,
          23,
          'Gemini public model docs',
          'https://ai.google.dev/gemini-api/docs/models',
          'gemini_public_model_docs'
        ),
        (
          'local',
          'ollama',
          'ollama/qwen3:32b',
          'qwen3:32b',
          'qwen',
          ${sql.json(["text", "code"])},
          true,
          0,
          0,
          82,
          0,
          'Local Ollama runtime',
          'https://ollama.com/',
          'ollama_tags_api'
        )
    `;

    await refreshModelCatalogMetadata(sql, {
      hiveId,
      fetchLiveMetadata: false,
    });

    const rows = await sql<{
      model_id: string;
      catalog_cost_per_input_token: string | null;
      catalog_cost_per_output_token: string | null;
      catalog_benchmark_quality_score: string | null;
      catalog_routing_cost_score: string | null;
      hive_cost_per_input_token: string | null;
      hive_cost_per_output_token: string | null;
      hive_benchmark_quality_score: string | null;
      hive_routing_cost_score: string | null;
      metadata_source_name: string | null;
    }[]>`
      SELECT
        hm.model_id,
        mc.cost_per_input_token AS catalog_cost_per_input_token,
        mc.cost_per_output_token AS catalog_cost_per_output_token,
        mc.benchmark_quality_score AS catalog_benchmark_quality_score,
        mc.routing_cost_score AS catalog_routing_cost_score,
        hm.cost_per_input_token AS hive_cost_per_input_token,
        hm.cost_per_output_token AS hive_cost_per_output_token,
        hm.benchmark_quality_score AS hive_benchmark_quality_score,
        hm.routing_cost_score AS hive_routing_cost_score,
        mc.metadata_source_name
      FROM hive_models hm
      JOIN model_catalog mc ON mc.id = hm.model_catalog_id
      WHERE hm.hive_id = ${hiveId}
      ORDER BY hm.model_id
    `;

    expect(rows).toEqual([
      {
        model_id: "google/gemini-3.1-pro",
        catalog_cost_per_input_token: null,
        catalog_cost_per_output_token: null,
        catalog_benchmark_quality_score: null,
        catalog_routing_cost_score: null,
        hive_cost_per_input_token: null,
        hive_cost_per_output_token: null,
        hive_benchmark_quality_score: null,
        hive_routing_cost_score: null,
        metadata_source_name: "Gemini public model docs",
      },
      {
        model_id: "ollama/qwen3:32b",
        catalog_cost_per_input_token: "0.000000000000",
        catalog_cost_per_output_token: "0.000000000000",
        catalog_benchmark_quality_score: null,
        catalog_routing_cost_score: "0.00",
        hive_cost_per_input_token: "0.000000000000",
        hive_cost_per_output_token: "0.000000000000",
        hive_benchmark_quality_score: null,
        hive_routing_cost_score: "0.00",
        metadata_source_name: "Local Ollama runtime",
      },
    ]);
  });

  it("enriches discovered catalog models from live source text without a hardcoded model entry", async () => {
    const hiveId = await createHive("catalog-dynamic-live-metadata");
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        adapter_type,
        model_id,
        enabled,
        auto_discovered
      )
      VALUES (
        ${hiveId},
        'openai',
        'codex',
        'openai-codex/gpt-5-mini',
        true,
        true
      )
    `;
    await sql`
      INSERT INTO model_catalog (
        provider,
        adapter_type,
        model_id,
        display_name,
        family,
        capabilities,
        local,
        metadata_source_name,
        metadata_source_url,
        discovery_source
      )
      VALUES (
        'openai',
        'codex',
        'openai-codex/gpt-5-mini',
        'gpt-5-mini',
        'gpt-5',
        ${sql.json(["text", "code", "reasoning"])},
        false,
        'OpenAI public model docs',
        'https://developers.openai.com/api/docs/models/all/',
        'openai_public_model_docs'
      )
    `;

    await refreshModelCatalogMetadata(sql, {
      hiveId,
      fetchLiveMetadata: true,
      fetchImpl: async (url) => {
        const href = String(url);
        if (href === "https://openai.com/api/pricing/") {
          return new Response(`
            GPT-5 mini
            Input price $0.25 / 1M tokens
            Output price $2.00 / 1M tokens
            GPT-5 nano
          `);
        }
        if (href === "https://llm-stats.com/leaderboards/llm-leaderboard") {
          return new Response(`
Model Country License Context Input $/M Output $/M Speed Code Arena Reasoning Math Coding Search Writing Vision Tools Long Ctx Finance Legal Health
GPT-5 Mini Closed 400k $0.25 $2.00 300 c/s 980 41.0 35.0 52.0 31.0 28.0 33.0 30.0 25.0 20.0 60.0 47.0
`);
        }
        return new Response("");
      },
    });

    const [row] = await sql<{
      catalog_cost_per_input_token: string | null;
      catalog_cost_per_output_token: string | null;
      catalog_routing_cost_score: string | null;
      hive_cost_per_input_token: string | null;
      hive_cost_per_output_token: string | null;
      metadata_source_name: string | null;
      metadata_source_url: string | null;
    }[]>`
      SELECT
        mc.cost_per_input_token AS catalog_cost_per_input_token,
        mc.cost_per_output_token AS catalog_cost_per_output_token,
        mc.routing_cost_score AS catalog_routing_cost_score,
        hm.cost_per_input_token AS hive_cost_per_input_token,
        hm.cost_per_output_token AS hive_cost_per_output_token,
        mc.metadata_source_name,
        mc.metadata_source_url
      FROM hive_models hm
      JOIN model_catalog mc ON mc.id = hm.model_catalog_id
      WHERE hm.hive_id = ${hiveId}
        AND hm.model_id = 'openai-codex/gpt-5-mini'
    `;
    const scores = await sql<{ axis: string; score: string; model_version_matched: string }[]>`
      SELECT axis, score, model_version_matched
      FROM model_capability_scores
      WHERE provider = 'openai'
        AND adapter_type = 'codex'
        AND canonical_model_id = 'openai-codex/gpt-5-mini'
      ORDER BY axis
    `;

    expect(row).toMatchObject({
      catalog_cost_per_input_token: "0.000000250000",
      catalog_cost_per_output_token: "0.000002000000",
      catalog_routing_cost_score: "5.00",
      hive_cost_per_input_token: "0.000000250000",
      hive_cost_per_output_token: "0.000002000000",
      metadata_source_name: "OpenAI API pricing",
      metadata_source_url: "https://openai.com/api/pricing/",
    });
    expect(scores).toContainEqual({
      axis: "coding",
      score: "52.00",
      model_version_matched: "GPT-5 Mini",
    });
    expect(scores).toContainEqual({
      axis: "reasoning",
      score: "41.00",
      model_version_matched: "GPT-5 Mini",
    });
  });
});
