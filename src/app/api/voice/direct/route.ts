import { NextResponse } from "next/server";
import { requireApiUser } from "../../_lib/auth";
import { sql } from "../../_lib/db";
import { canAccessHive } from "@/auth/users";
import { signVoiceSessionToken } from "@/lib/voice-session-token";

/**
 * POST /api/voice/direct
 *
 * Mints a short-lived signed handshake token the PWA uses to open a
 * WebSocket directly to the dispatcher's `/api/voice/direct/ws` endpoint
 * for the new (post-Twilio) Voice EA path.
 *
 * Body: `{ hiveId: string }`
 * Returns:
 *   {
 *     wsUrl: string,           // wss://<host>/api/voice/direct/ws?token=…
 *     sessionToken: string,    // the same token, exposed for tests
 *     expiresIn: 60,           // seconds
 *   }
 *
 * Auth: NextAuth session (owner) OR `Authorization: Bearer
 * $INTERNAL_SERVICE_TOKEN`. The hive access check enforces single-owner v1.
 *
 * The `wsUrl` reuses whatever host the request came in on. In production
 * the PWA loads from `https://<host>.ts.net/`, so the WS opens against the
 * same `<host>.ts.net` on port 443 — Tailscale `serve` is configured to
 * proxy `/api/voice/direct/ws` from :443 to the dispatcher's :8791. See
 * the operator runbook for the exact `tailscale serve` invocation.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const body = (await req.json().catch(() => ({}))) as { hiveId?: unknown };
  const hiveId = typeof body.hiveId === "string" ? body.hiveId : "";
  if (!hiveId) {
    return NextResponse.json({ error: "hiveId required" }, { status: 400 });
  }

  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
    if (!hasAccess) {
      return NextResponse.json(
        { error: "Forbidden: caller cannot access this hive" },
        { status: 403 },
      );
    }
  }

  // Reconstruct the public origin from the request — survives any
  // reverse-proxy hop without depending on env config.
  const url = new URL(req.url);
  const wsScheme = url.protocol === "https:" ? "wss:" : "ws:";
  const sessionToken = signVoiceSessionToken({
    hiveId,
    ownerId: authz.user.id,
  });
  const wsUrl = `${wsScheme}//${url.host}/api/voice/direct/ws?token=${encodeURIComponent(sessionToken)}`;

  return NextResponse.json({ wsUrl, sessionToken, expiresIn: 60 });
}
