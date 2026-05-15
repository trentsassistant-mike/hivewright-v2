import { sql } from "../../_lib/db";
import { requireApiUser } from "../../_lib/auth";
import { jsonError, jsonOk } from "../../_lib/responses";
import { HiveSetupError, plainSetupError, runHiveSetup, type HiveSetupRequest } from "@/hives/setup";

export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  if (!authz.user.isSystemOwner) {
    return jsonError("Only the owner can create a hive.", 403);
  }

  try {
    const body = await request.json() as HiveSetupRequest;
    const result = await runHiveSetup(sql, body);

    return jsonOk(result, 201);
  } catch (err) {
    console.error("[api/hives/setup POST]", err);
    if (err instanceof HiveSetupError) {
      return jsonError(err.message, err.status);
    }
    return jsonError(plainSetupError(err), 500);
  }
}
