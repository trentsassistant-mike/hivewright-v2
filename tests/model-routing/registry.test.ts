import { beforeEach, describe, expect, it } from "vitest";
import {
  loadModelRoutingView,
  routeKeyForModel,
} from "@/model-routing/registry";
import { saveModelRoutingPolicy } from "@/model-routing/policy";
import { createRuntimeCredentialFingerprint } from "@/model-health/probe-runner";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_ID = "bbbbbbbb-7777-4777-8777-bbbbbbbbbbbb";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'routing-view-hive', 'Routing View Hive', 'digital')
  `;
});

describe("model routing registry view", () => {
  it("builds route keys from provider, adapter, and model", () => {
    expect(routeKeyForModel({
      provider: "openai",
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
    })).toBe("openai:codex:openai-codex/gpt-5.5");
  });

  it("derives model rows from configured hive models and health", async () => {
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "openai",
      adapterType: "codex",
      baseUrl: null,
    });

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
      VALUES (
        ${HIVE_ID},
        'openai',
        'openai-codex/gpt-5.5',
        'codex',
        96,
        25,
        true
      )
    `;

    await sql`
      INSERT INTO model_health (
        fingerprint,
        model_id,
        status,
        latency_ms
      )
      VALUES (${fingerprint}, 'openai-codex/gpt-5.5', 'healthy', 1200)
    `;

    const view = await loadModelRoutingView(sql, HIVE_ID);

    expect(view.models).toHaveLength(1);
    expect(view.models[0]).toMatchObject({
      routeKey: "openai:codex:openai-codex/gpt-5.5",
      provider: "openai",
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      hiveModelEnabled: true,
      routingEnabled: true,
      status: "healthy",
      qualityScore: 96,
      costScore: 25,
      local: false,
      latencyMs: 1200,
    });
    expect(view.policy.candidates[0]).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      status: "healthy",
      qualityScore: 96,
      costScore: 25,
    });
  });

  it("collapses provider-prefixed aliases into one routing row", async () => {
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        benchmark_quality_score,
        routing_cost_score,
        fallback_priority,
        enabled
      )
      VALUES
        (${HIVE_ID}, 'openai', 'gpt-5.5', 'codex', 94, 20, 100, true),
        (${HIVE_ID}, 'openai', 'openai-codex/gpt-5.5', 'codex', 96, 25, 100, true)
    `;

    const view = await loadModelRoutingView(sql, HIVE_ID);

    expect(view.models).toHaveLength(1);
    expect(view.models[0]).toMatchObject({
      routeKey: "openai:codex:openai-codex/gpt-5.5",
      provider: "openai",
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      qualityScore: 96,
      costScore: 25,
    });
    expect(view.policy.candidates).toHaveLength(1);
    expect(view.policy.candidates[0]).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
    });
  });

  it("applies saved routing overrides without changing registry facts", async () => {
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
      VALUES (${HIVE_ID}, 'local', 'ollama/qwen3:32b', 'ollama', 80, 0, true)
    `;

    await saveModelRoutingPolicy(sql, HIVE_ID, {
      preferences: { costQualityBalance: 17 },
      routeOverrides: {
        "local:ollama:ollama/qwen3:32b": {
          enabled: false,
          roleSlugs: ["dev-agent"],
        },
      },
      candidates: [
        {
          adapterType: "codex",
          model: "unconfigured/free-text",
          status: "healthy",
          qualityScore: 100,
          costScore: 0,
        },
      ],
    });

    const view = await loadModelRoutingView(sql, HIVE_ID);

    expect(view.models).toHaveLength(1);
    expect(view.models[0]).toMatchObject({
      routeKey: "local:ollama:ollama/qwen3:32b",
      routingEnabled: false,
      roleSlugs: ["dev-agent"],
      adapterType: "ollama",
      model: "ollama/qwen3:32b",
    });
    expect(view.policy.candidates).toHaveLength(1);
    expect(view.policy.candidates[0]).toMatchObject({
      adapterType: "ollama",
      model: "ollama/qwen3:32b",
      enabled: false,
      roleSlugs: ["dev-agent"],
    });
  });

  it("does not let routing overrides re-enable disabled hive models", async () => {
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

    await saveModelRoutingPolicy(sql, HIVE_ID, {
      routeOverrides: {
        "openai:codex:openai-codex/gpt-5.5": {
          enabled: true,
        },
      },
      candidates: [],
    });

    const view = await loadModelRoutingView(sql, HIVE_ID);

    expect(view.models).toHaveLength(1);
    expect(view.models[0]).toMatchObject({
      routeKey: "openai:codex:openai-codex/gpt-5.5",
      hiveModelEnabled: false,
      routingEnabled: true,
      roleSlugs: [],
    });
    expect(view.policy.candidates[0]).toMatchObject({
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      enabled: false,
    });
    expect(view.policy.candidates[0].roleSlugs).toBeUndefined();
  });
});
