import { canAccessHive } from "@/auth/users";
import { requireApiUser } from "@/app/api/_lib/auth";
import { sql } from "@/app/api/_lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/voice/sessions/latest?hiveId=...
 *
 * Returns the most recently started voice session for a hive, or
 * `{ session: null }` if none exists. The PWA calls this after
 * `call.on("accept")` fires to discover the session id it should subscribe
 * to via `/api/voice/sessions/[id]/events` — the dispatcher WS server that
 * would otherwise echo the id back through Twilio call parameters isn't
 * built yet, so this two-step lookup is the v1 shim.
 *
 * No 404 when empty — voice runtime creates the row on the first Twilio
 * `start` frame, and there's a real window between `accept` and that frame
 * where the client can race ahead; returning `null` lets the client retry
 * without treating it as an error.
 *
 * Non-owner callers must have read access to the requested hive.
 */
export async function GET(req: Request): Promise<Response> {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;

  const url = new URL(req.url);
  const hiveId = url.searchParams.get("hiveId");
  if (!hiveId) {
    return Response.json({ error: "hiveId required" }, { status: 400 });
  }
  if (!user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, user.id, hiveId);
    if (!hasAccess) {
      return Response.json(
        { error: "Forbidden: caller cannot access this hive" },
        { status: 403 },
      );
    }
  }

  const [row] = await sql<
    { id: string; hiveId: string; startedAt: Date; endedAt: Date | null }[]
  >`
    SELECT id, hive_id AS "hiveId", started_at AS "startedAt", ended_at AS "endedAt"
    FROM voice_sessions
    WHERE hive_id = ${hiveId}
    ORDER BY started_at DESC
    LIMIT 1
  `;

  return Response.json({ session: row ?? null });
}
