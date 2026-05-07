import { beforeEach, describe, expect, it } from "vitest";
import {
  resolveGoalSupervisorRouteFromConfig,
  resolveGoalSupervisorRuntime,
} from "@/goals/supervisor-routing";
import type { ModelCapabilityAxis, ModelCapabilityScoreView } from "@/model-catalog/capability-scores";
import { createRuntimeCredentialFingerprint } from "@/model-health/probe-runner";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_ID = "bbbbbbbb-6666-4666-8666-bbbbbbbbbbbb";

beforeEach(async () => {
  await truncateAll(sql);
});

function capability(axis: ModelCapabilityAxis, score: number): ModelCapabilityScoreView {
  return {
    modelCatalogId: null,
    provider: "test",
    adapterType: "test",
    modelId: "test/model",
    canonicalModelId: "test/model",
    axis,
    score,
    rawScore: null,
    source: "test",
    sourceUrl: "https://example.test",
    benchmarkName: "test-benchmark",
    modelVersionMatched: "test/model",
    confidence: "high",
    updatedAt: null,
  };
}

describe("goal supervisor runtime routing", () => {
  it("uses auto model routing while filtering to persistent supervisor backends", () => {
    const route = resolveGoalSupervisorRouteFromConfig({
      adapterType: "auto",
      recommendedModel: "auto",
      policy: {
        preferences: { costQualityBalance: 100 },
        candidates: [
          {
            adapterType: "gemini",
            model: "google/gemini-best",
            enabled: true,
            qualityScore: 99,
            roleSlugs: ["goal-supervisor"],
          },
          {
            adapterType: "codex",
            model: "openai-codex/gpt-5.5",
            enabled: true,
            qualityScore: 90,
            roleSlugs: ["goal-supervisor"],
          },
        ],
      },
    });

    expect(route).toMatchObject({
      backend: "codex",
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
    });
  });

  it("keeps explicit dashboard pins for supported supervisor backends", () => {
    const route = resolveGoalSupervisorRouteFromConfig({
      adapterType: "openclaw",
      recommendedModel: "openai-codex/gpt-5.4",
      policy: null,
    });

    expect(route).toMatchObject({
      backend: "openclaw",
      adapterType: "openclaw",
      model: "openai-codex/gpt-5.4",
    });
  });

  it("returns null when auto routing has no supported persistent supervisor candidate", () => {
    const route = resolveGoalSupervisorRouteFromConfig({
      adapterType: "auto",
      recommendedModel: "auto",
      policy: {
        candidates: [
          {
            adapterType: "gemini",
            model: "google/gemini-best",
            enabled: true,
            qualityScore: 99,
            roleSlugs: ["goal-supervisor"],
          },
        ],
      },
    });

    expect(route).toBeNull();
  });

  it("uses goal context so coding goals can select a coding-strong supervisor route", () => {
    const route = resolveGoalSupervisorRouteFromConfig({
      adapterType: "auto",
      recommendedModel: "auto",
      goalContext: {
        title: "Implement TypeScript API tests",
        description: "Fix route handler code and add Vitest coverage for the API.",
        status: "active",
      },
      policy: {
        preferences: { costQualityBalance: 100 },
        candidates: [
          {
            adapterType: "openclaw",
            model: "openclaw/analysis-supervisor",
            enabled: true,
            qualityScore: 95,
            costScore: 0,
            roleSlugs: ["goal-supervisor"],
            capabilityScores: [
              capability("reasoning", 98),
              capability("math", 90),
              capability("overall_quality", 95),
              capability("long_context", 92),
              capability("coding", 45),
              capability("tool_use", 50),
              capability("speed", 80),
            ],
          },
          {
            adapterType: "codex",
            model: "openai-codex/gpt-5.5",
            enabled: true,
            qualityScore: 90,
            costScore: 80,
            roleSlugs: ["goal-supervisor"],
            capabilityScores: [
              capability("reasoning", 86),
              capability("math", 70),
              capability("overall_quality", 88),
              capability("long_context", 80),
              capability("coding", 96),
              capability("tool_use", 90),
              capability("speed", 70),
            ],
          },
        ],
      },
    });

    expect(route).toMatchObject({
      backend: "codex",
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      route: {
        profile: "coding",
      },
    });
  });

  it("resolves runtime auto routing from configured hive models and health", async () => {
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "openai",
      adapterType: "codex",
      baseUrl: null,
    });

    await sql`
      INSERT INTO hives (id, slug, name, type)
      VALUES (${HIVE_ID}, 'supervisor-routing-hive', 'Supervisor Routing Hive', 'digital')
    `;
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, description, status, session_id)
      VALUES (${HIVE_ID}, 'Supervisor routing', 'Use registry routing', 'active', 'supervisor-routing-session')
      RETURNING id
    `;
    await sql`
      UPDATE role_templates
      SET adapter_type = 'auto',
          recommended_model = 'auto'
      WHERE slug = 'goal-supervisor'
    `;
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
      INSERT INTO model_health (fingerprint, model_id, status)
      VALUES (${fingerprint}, 'openai-codex/gpt-5.5', 'healthy')
      ON CONFLICT (fingerprint, model_id) DO UPDATE SET status = EXCLUDED.status
    `;
    await sql`
      INSERT INTO adapter_config (hive_id, adapter_type, config)
      VALUES (${HIVE_ID}, 'model-routing', ${sql.json({
        preferences: { costQualityBalance: 17 },
        routeOverrides: {
          "openai:codex:openai-codex/gpt-5.5": {
            roleSlugs: ["goal-supervisor"],
          },
        },
      })})
    `;

    const runtime = await resolveGoalSupervisorRuntime(sql, goal.id);

    expect(runtime).toMatchObject({
      backend: "codex",
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
    });
  });
});
