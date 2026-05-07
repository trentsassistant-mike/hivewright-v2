import { sql } from "../../_lib/db";
import { jsonError, jsonOk } from "../../_lib/responses";
import { requireApiAuth } from "../../_lib/auth";
import { runDeliberation } from "@/board/deliberate";

export async function POST(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  try {
    const body = await request.json();
    const { hiveId, question, hiveContext } = body as {
      hiveId?: string;
      question?: string;
      hiveContext?: string;
    };
    if (!hiveId || !question) {
      return jsonError("hiveId and question are required", 400);
    }
    const result = await runDeliberation(sql, { hiveId, question, hiveContext });
    return jsonOk(result);
  } catch (err) {
    console.error("[api/board/deliberate]", err);
    return jsonError(
      err instanceof Error ? err.message : "Deliberation failed",
      500,
    );
  }
}
