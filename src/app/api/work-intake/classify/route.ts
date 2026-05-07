import { sql } from "../../_lib/db";
import { jsonOk, jsonError, parseSearchParams } from "../../_lib/responses";
import { requireApiAuth } from "../../_lib/auth";
import { runClassifier } from "@/work-intake/runner";

export async function POST(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  try {
    const body = await request.json();
    const input = typeof body?.input === "string" ? body.input : "";
    if (!input.trim()) return jsonError("input is required", 400);

    const params = parseSearchParams(request.url);
    const dryRun = params.get("dryRun") === "true";

    const outcome = await runClassifier(sql, input);

    const totalLatency = outcome.attempts.reduce((sum, a) => sum + a.latencyMs, 0);

    const response = {
      result: outcome.result,
      provider: outcome.providerUsed,
      model: outcome.modelUsed,
      latencyMs: totalLatency,
      usedFallback: outcome.usedFallback,
      attempts: outcome.attempts.map((a) => ({
        provider: a.provider,
        model: a.model,
        success: a.success,
        errorReason: a.errorReason,
        latencyMs: a.latencyMs,
        tokensIn: a.tokensIn,
        tokensOut: a.tokensOut,
      })),
    };

    if (dryRun) return jsonOk(response);

    // Non-dry runs write a classifier_logs row per attempt with no
    // classification_id link (since no task/goal was created). Useful
    // for debugging from the dashboard without polluting the normal flow.
    for (const a of outcome.attempts) {
      await sql`
        INSERT INTO classifier_logs (
          classification_id, provider, model, request_input, request_prompt,
          response_raw, tokens_input, tokens_output, cost_cents,
          latency_ms, success, error_reason
        ) VALUES (
          NULL, ${a.provider}, ${a.model ?? ""}, ${a.input}, ${a.prompt},
          ${a.responseRaw}, ${a.tokensIn}, ${a.tokensOut}, ${a.costCents},
          ${a.latencyMs}, ${a.success}, ${a.errorReason}
        )
      `;
    }
    return jsonOk(response);
  } catch {
    return jsonError("Failed to classify", 500);
  }
}
