import { sql } from "../../_lib/db";
import { requireApiAuth } from "../../_lib/auth";
import { jsonOk, jsonError } from "../../_lib/responses";

export async function GET() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;

  try {
    const rows = await sql<{
      provider: string;
      last_success_at: Date | null;
      last_failure_at: Date | null;
      last_failure_reason: string | null;
    }[]>`
      WITH ranked AS (
        SELECT provider,
               success,
               error_reason,
               created_at,
               ROW_NUMBER() OVER (PARTITION BY provider, success ORDER BY created_at DESC) AS rn
        FROM classifier_logs
      )
      SELECT
        provider,
        MAX(created_at) FILTER (WHERE success AND rn = 1) AS last_success_at,
        MAX(created_at) FILTER (WHERE NOT success AND rn = 1) AS last_failure_at,
        MAX(error_reason) FILTER (WHERE NOT success AND rn = 1) AS last_failure_reason
      FROM ranked
      GROUP BY provider
    `;

    const out: Record<string, unknown> = {};
    for (const r of rows) {
      out[r.provider] = {
        provider: r.provider,
        lastSuccessAt: r.last_success_at?.toISOString() ?? null,
        lastFailureAt: r.last_failure_at?.toISOString() ?? null,
        lastFailureReason: r.last_failure_reason ?? null,
      };
    }
    return jsonOk(out);
  } catch {
    return jsonError("Failed to read classifier health", 500);
  }
}
