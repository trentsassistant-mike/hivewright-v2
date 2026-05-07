import { sql } from "../../_lib/db";
import { jsonError, jsonOk } from "../../_lib/responses";
import { requireApiAuth } from "../../_lib/auth";
import { promoteInsightToInstruction } from "@/standing-instructions/manager";

/**
 * Owner override for the curator. Lets the dashboard transition an insight
 * between terminal statuses when the curator's classification was wrong:
 *
 *   - "actioned"     → promote to a standing instruction (idempotent)
 *   - "dismissed"    → mark as not actionable
 *   - "acknowledged" → keep visible but inert
 *   - "new"          → re-queue for the next curator pass
 *
 * Status transitions are owner-driven, so we always overwrite curator_reason
 * with an "Owner override:" prefix so future readers understand who decided.
 */
const ALLOWED_STATUSES = new Set([
  "new",
  "acknowledged",
  "actioned",
  "dismissed",
  "escalated",
]);

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  try {
    const { id } = await ctx.params;
    if (!id) return jsonError("id is required", 400);

    let body: { status?: string; note?: string };
    try {
      body = (await request.json()) as { status?: string; note?: string };
    } catch {
      return jsonError("Invalid JSON body", 400);
    }

    if (!body.status || !ALLOWED_STATUSES.has(body.status)) {
      return jsonError(
        `status must be one of: ${[...ALLOWED_STATUSES].join(", ")}`,
        400,
      );
    }

    const [insight] = await sql`
      SELECT id, hive_id, status, decision_id FROM insights WHERE id = ${id}
    `;
    if (!insight) return jsonError("Insight not found", 404);

    const reason = `Owner override: ${body.note?.trim() || `set to "${body.status}"`}`;

    if (body.status === "actioned") {
      const [existing] = await sql`
        SELECT id FROM standing_instructions WHERE source_insight_id = ${id}
      `;
      if (!existing) {
        await promoteInsightToInstruction(sql, id);
      }
      await sql`
        UPDATE insights
        SET curator_reason = ${reason}, curated_at = NOW(), updated_at = NOW()
        WHERE id = ${id}
      `;
    } else {
      await sql`
        UPDATE insights
        SET status = ${body.status},
            curator_reason = ${reason},
            curated_at = NOW(),
            updated_at = NOW()
        WHERE id = ${id}
      `;
    }

    // If this insight was escalated (and therefore spawned a decision row),
    // resolving the insight implicitly resolves the decision — otherwise the
    // decision lingers in the owner-brief "needs your input" counter forever
    // even though the owner has already acted via the insights inbox.
    if (insight.decision_id) {
      await sql`
        UPDATE decisions
        SET status = 'resolved',
            owner_response = ${`Resolved via insights inbox: ${body.status}` + (body.note?.trim() ? ` (${body.note.trim()})` : "")},
            resolved_at = NOW()
        WHERE id = ${insight.decision_id} AND status = 'pending'
      `;
    }

    const [updated] = await sql`
      SELECT id, status, curator_reason, curated_at, updated_at
      FROM insights WHERE id = ${id}
    `;
    return jsonOk(updated);
  } catch (err) {
    console.error("[api/insights PATCH]", err);
    return jsonError("Failed to update insight", 500);
  }
}
