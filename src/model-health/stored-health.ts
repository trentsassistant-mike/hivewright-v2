import type { Sql } from "postgres";
import { canonicalModelIdForAdapter } from "./model-identity";

export interface StoredModelHealthRow {
  model_id: string;
  status: string;
  last_probed_at: Date | null;
  last_failed_at: Date | null;
  last_failure_reason: string | null;
  next_probe_at: Date | null;
  latency_ms: number | null;
  sample_cost_usd: string | number | null;
}

export async function loadModelHealthByIdentity(
  sql: Sql,
  input: {
    fingerprint: string;
    adapterType: string;
    modelId: string;
  },
): Promise<StoredModelHealthRow | undefined> {
  const canonicalModelId = canonicalModelIdForAdapter(input.adapterType, input.modelId);
  const [health] = await sql<StoredModelHealthRow[]>`
    SELECT
      model_id,
      status,
      last_probed_at,
      last_failed_at,
      last_failure_reason,
      next_probe_at,
      latency_ms,
      sample_cost_usd
    FROM model_health
    WHERE fingerprint = ${input.fingerprint}
      AND model_id IN (${canonicalModelId}, ${input.modelId})
    ORDER BY CASE WHEN model_id = ${canonicalModelId} THEN 0 ELSE 1 END
    LIMIT 1
  `;
  return health;
}
