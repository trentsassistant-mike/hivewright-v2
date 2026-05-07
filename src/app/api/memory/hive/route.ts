import { sql } from "../../_lib/db";
import { jsonOk, jsonError } from "../../_lib/responses";
import { enforceInternalTaskHiveScope, requireApiAuth } from "../../_lib/auth";
import { maybeRecordEaHiveSwitch } from "@/ea/native/hive-switch-audit";

export async function POST(request: Request) {
  const unauth = await requireApiAuth();
  if (unauth) return unauth;
  try {
    const body = await request.json();
    const { hiveId, content, category } = body;

    if (!hiveId || !content) {
      return jsonError("Missing required fields: hiveId, content", 400);
    }

    const taskScope = await enforceInternalTaskHiveScope(hiveId);
    if (!taskScope.ok) return taskScope.response;

    const rows = await sql`
      INSERT INTO hive_memory (hive_id, content, category, confidence)
      VALUES (
        ${hiveId},
        ${content},
        ${category ?? "general"},
        ${1.0}
      )
      RETURNING id, hive_id, content, category, confidence, sensitivity, created_at, updated_at
    `;

    const row = rows[0] as { id: string };
    await maybeRecordEaHiveSwitch(sql, request, hiveId, {
      type: "hive_memory",
      id: row.id,
    });
    return jsonOk(rows[0], 201);
  } catch {
    return jsonError("Failed to insert hive memory", 500);
  }
}
