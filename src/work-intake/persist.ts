import type { Sql } from "postgres";
import type { ClassifierOutcome } from "./types";

/**
 * After a task or goal row has been inserted, call this to persist:
 *   - one `classifications` row linked to the task/goal
 *   - one `classifier_logs` row per attempt (linked to the classification)
 *
 * For null outcomes (default-to-goal), pass target='goal' + the new goal id.
 */
export async function persistClassification(
  sql: Sql,
  params: {
    target: "task" | "goal";
    targetId: string;
    outcome: ClassifierOutcome;
  },
): Promise<{ classificationId: string | null }> {
  const { target, targetId, outcome } = params;

  let classificationId: string | null = null;

  if (outcome.result) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO classifications (
        task_id, goal_id, type, assigned_role, confidence, reasoning,
        provider, model, was_fallback
      ) VALUES (
        ${target === "task" ? targetId : null},
        ${target === "goal" ? targetId : null},
        ${outcome.result.type},
        ${outcome.result.type === "task" ? outcome.result.role : null},
        ${outcome.result.confidence},
        ${outcome.result.reasoning},
        ${outcome.providerUsed},
        ${outcome.modelUsed},
        ${outcome.usedFallback}
      )
      RETURNING id
    `;
    classificationId = row.id;
  } else {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO classifications (
        task_id, goal_id, type, confidence, reasoning,
        provider, model, was_fallback
      ) VALUES (
        NULL,
        ${targetId},
        'goal',
        0.00,
        ${"Classifier produced no confident result; system defaulted to creating a goal."},
        'default-goal-fallback',
        NULL,
        ${outcome.attempts.length > 1}
      )
      RETURNING id
    `;
    classificationId = row.id;
  }

  for (const a of outcome.attempts) {
    await sql`
      INSERT INTO classifier_logs (
        classification_id, provider, model, request_input, request_prompt,
        response_raw, tokens_input, tokens_output, cost_cents,
        latency_ms, success, error_reason
      ) VALUES (
        ${classificationId},
        ${a.provider},
        ${a.model ?? ""},
        ${a.input},
        ${a.prompt},
        ${a.responseRaw},
        ${a.tokensIn},
        ${a.tokensOut},
        ${a.costCents},
        ${a.latencyMs},
        ${a.success},
        ${a.errorReason}
      )
    `;
  }

  return { classificationId };
}
