import { sql } from "../../_lib/db";
import { jsonError, jsonOk } from "../../_lib/responses";
import { requireApiAuth } from "../../_lib/auth";
import { runImprovementSweep } from "@/improvement/sweeper";

/**
 * POST /api/improvement/run — manual trigger for the system-improvement
 * sweeper. Useful for demos and bug repros; normally the dispatcher runs
 * this weekly on its own timer.
 */
export async function POST() {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  try {
    const results = await runImprovementSweep(sql);
    return jsonOk({ results, ranAt: new Date().toISOString() });
  } catch (err) {
    console.error("[api/improvement/run]", err);
    return jsonError(
      err instanceof Error ? err.message : "Improvement sweep failed",
      500,
    );
  }
}
