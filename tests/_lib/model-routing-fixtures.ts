import type { Sql } from "postgres";
import { createRuntimeCredentialFingerprint } from "@/model-health/probe-runner";

const DEFAULT_CODEX_MODEL = "openai-codex/gpt-5.5";

// G3 regression fixture for failed task 49dc63d0-b126-41b0-affc-7ffd546189de.
export async function seedHealthyCodexAutoRoute(
  sql: Sql,
  hiveId: string,
  roleSlugs: string[] = ["dev-agent"],
): Promise<void> {
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
    VALUES (${hiveId}, 'openai', ${DEFAULT_CODEX_MODEL}, 'codex', 90, 20, true)
    ON CONFLICT (hive_id, provider, model_id) DO UPDATE
    SET adapter_type = EXCLUDED.adapter_type,
        benchmark_quality_score = EXCLUDED.benchmark_quality_score,
        routing_cost_score = EXCLUDED.routing_cost_score,
        enabled = EXCLUDED.enabled
  `;
  await sql`
    INSERT INTO model_health (fingerprint, model_id, status)
    VALUES (${fingerprint}, ${DEFAULT_CODEX_MODEL}, 'healthy')
    ON CONFLICT (fingerprint, model_id) DO UPDATE SET status = EXCLUDED.status
  `;
  await sql`
    DELETE FROM adapter_config
    WHERE hive_id = ${hiveId}
      AND adapter_type = 'model-routing'
  `;
  await sql`
    INSERT INTO adapter_config (hive_id, adapter_type, config)
    VALUES (
      ${hiveId},
      'model-routing',
      ${sql.json({
        routeOverrides: {
          [`openai:codex:${DEFAULT_CODEX_MODEL}`]: { roleSlugs },
        },
      })}
    )
  `;
}
