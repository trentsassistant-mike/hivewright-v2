import { requireApiUser } from "@/app/api/_lib/auth";
import { sql } from "@/app/api/_lib/db";
import { canAccessHive } from "@/auth/users";
import { db } from "@/db";
import { voiceSessionEvents, voiceSessions } from "@/db/schema/voice-sessions";
import { and, eq, gt } from "drizzle-orm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/voice/sessions/[id]/events
 *
 * Server-Sent Events stream of `voice_session_events` rows for the given
 * session, in chronological order. The PWA opens this as an `EventSource`
 * after `call.on("accept")` fires so the live transcript can fill in as
 * the EA and owner speak.
 *
 * Implementation: polls the DB every 500ms with a cursor on `at`; each new
 * row is emitted as an SSE frame where `event:` is the `kind` column and
 * `data:` is the JSON-encoded row. Client-driven termination is honored via
 * `req.signal.aborted` and the `ReadableStream.cancel()` hook; a 15-minute
 * wall-clock cap protects against wedged clients that never abort.
 *
 * Auth: `requireApiUser` plus hive read access on the session's owning hive.
 */
const POLL_INTERVAL_MS = 500;
const MAX_DURATION_MS = 15 * 60 * 1000;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id: sessionId } = await params;
  const [session] = await db
    .select({ hiveId: voiceSessions.hiveId })
    .from(voiceSessions)
    .where(eq(voiceSessions.id, sessionId))
    .limit(1);
  if (!session) {
    return new Response(JSON.stringify({ error: "Voice session not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, session.hiveId);
    if (!hasAccess) {
      return new Response(
        JSON.stringify({ error: "Forbidden: caller cannot access this voice session's hive" }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }
  }

  const encoder = new TextEncoder();
  const startedAt = Date.now();
  let cursor = new Date(0);
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try {
        while (
          !cancelled &&
          !req.signal.aborted &&
          Date.now() - startedAt < MAX_DURATION_MS
        ) {
          const rows = await db
            .select()
            .from(voiceSessionEvents)
            .where(
              and(
                eq(voiceSessionEvents.sessionId, sessionId),
                gt(voiceSessionEvents.at, cursor),
              ),
            )
            .orderBy(voiceSessionEvents.at);
          for (const row of rows) {
            cursor = row.at;
            ctrl.enqueue(
              encoder.encode(
                `event: ${row.kind}\ndata: ${JSON.stringify(row)}\n\n`,
              ),
            );
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
      } finally {
        try {
          ctrl.close();
        } catch {
          // Stream may already be closed if the client aborted mid-enqueue.
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
