import type { Sql } from "postgres";

export const MODEL_CAPABILITY_AXES = [
  "overall_quality",
  "reasoning",
  "coding",
  "math",
  "search",
  "writing",
  "vision",
  "tool_use",
  "long_context",
  "finance",
  "legal",
  "health_medical",
  "speed",
  "cost",
] as const;

export type ModelCapabilityAxis = (typeof MODEL_CAPABILITY_AXES)[number];

export type ModelCapabilityConfidence = "high" | "medium" | "low";

export interface ModelCapabilityScoreInput {
  modelCatalogId: string | null;
  provider: string;
  adapterType: string;
  modelId: string;
  canonicalModelId: string;
  axis: ModelCapabilityAxis;
  score: number;
  rawScore: string | null;
  source: string;
  sourceUrl: string;
  benchmarkName: string;
  modelVersionMatched: string;
  confidence: ModelCapabilityConfidence;
}

export interface ModelCapabilityScoreView extends ModelCapabilityScoreInput {
  updatedAt: Date | null;
}

export function normalizeCapabilityScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const clamped = Math.max(0, Math.min(100, value));
  return Math.round(clamped * 100) / 100;
}

export async function upsertModelCapabilityScores(
  sql: Sql,
  scores: ModelCapabilityScoreInput[],
): Promise<number> {
  let upserted = 0;

  for (const score of scores) {
    const rows = await sql`
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
      VALUES (
        ${score.modelCatalogId},
        ${score.provider},
        ${score.adapterType},
        ${score.modelId},
        ${score.canonicalModelId},
        ${score.axis},
        ${normalizeCapabilityScore(score.score)},
        ${score.rawScore},
        ${score.source},
        ${score.sourceUrl},
        ${score.benchmarkName},
        ${score.modelVersionMatched},
        ${score.confidence},
        NOW()
      )
      ON CONFLICT (provider, adapter_type, canonical_model_id, axis, source, benchmark_name)
      DO UPDATE SET
        model_catalog_id = COALESCE(EXCLUDED.model_catalog_id, model_capability_scores.model_catalog_id),
        model_id = EXCLUDED.model_id,
        score = EXCLUDED.score,
        raw_score = EXCLUDED.raw_score,
        source_url = EXCLUDED.source_url,
        model_version_matched = EXCLUDED.model_version_matched,
        confidence = EXCLUDED.confidence,
        updated_at = NOW()
      RETURNING id
    `;

    upserted += rows.length;
  }

  return upserted;
}
