import { sql } from "../../_lib/db";
import { jsonError, jsonOk } from "../../_lib/responses";
import { bootstrapFirstOwner, countUsers } from "@/auth/users";

/**
 * POST /api/auth/bootstrap-owner — one-shot, only usable when the `users`
 * table is empty. Creates the first owner account. Subsequent users are
 * added via the authenticated admin flow (future work).
 */
export async function POST(request: Request) {
  try {
    const existing = await countUsers(sql);
    if (existing > 0) {
      return jsonError("Setup already complete. Sign in instead.", 409);
    }
    const body = await request.json();
    const { email, password, displayName } = body as {
      email?: string;
      password?: string;
      displayName?: string;
    };
    if (!email || !password) {
      return jsonError("email and password are required", 400);
    }
    if (password.length < 8) {
      return jsonError("password must be at least 8 characters", 400);
    }
    const user = await bootstrapFirstOwner(sql, { email, password, displayName });
    return jsonOk(
      { id: user.id, email: user.email, displayName: user.displayName },
      201,
    );
  } catch (err) {
    console.error("[api/auth/bootstrap-owner]", err);
    return jsonError(
      err instanceof Error ? err.message : "Bootstrap failed",
      500,
    );
  }
}
