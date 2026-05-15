import postgres from "postgres";
import { sql } from "../_lib/db";
import { requireApiUser } from "../_lib/auth";
import { canAccessHive } from "@/auth/users";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://hivewright@localhost:5432/hivewrightv2";
const HEARTBEAT_MS = 15_000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const hiveId = url.searchParams.get("hiveId");
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  if (hiveId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hiveId)) {
      return Response.json({ error: "hiveId must be a valid UUID" }, { status: 400 });
    }
    if (!authz.user.isSystemOwner) {
      const hasAccess = await canAccessHive(sql, authz.user.id, hiveId);
      if (!hasAccess) {
        return Response.json({ error: "Forbidden: caller cannot access this hive" }, { status: 403 });
      }
    }
  } else if (!authz.user.isSystemOwner) {
    return Response.json({ error: "Forbidden: hiveId is required for non-owner event streams" }, { status: 403 });
  }

  const encoder = new TextEncoder();
  let cleanup: (() => Promise<void>) | undefined;
  const stream = new ReadableStream({
    async start(controller) {
      const listener = postgres(DATABASE_URL, { max: 1 });
      let closed = false;
      const sendEvent = (data: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          closed = true;
        }
      };
      const sendHeartbeat = () => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat ${new Date().toISOString()}\n\n`));
        } catch {
          closed = true;
        }
      };
      const heartbeat = setInterval(sendHeartbeat, HEARTBEAT_MS);
      let cleanedUp = false;
      cleanup = async () => {
        if (cleanedUp) return;
        cleanedUp = true;
        closed = true;
        clearInterval(heartbeat);
        try {
          await listener.end();
        } catch {
          /* ignore */
        }
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      sendEvent(JSON.stringify({ type: "connected", timestamp: new Date().toISOString() }));

      await listener.listen("task_events", (payload) => {
        if (!hiveId) {
          sendEvent(payload);
          return;
        }
        try {
          const parsed = JSON.parse(payload) as { hiveId?: string };
          if (parsed.hiveId === hiveId) sendEvent(payload);
        } catch {
          console.warn(
            "[events] malformed task_events payload, dropping:",
            typeof payload === "string" ? payload.slice(0, 120) : "<non-string>",
          );
        }
      });

      await listener.listen("new_task", (payload) => {
        if (!hiveId) {
          sendEvent(
            JSON.stringify({
              type: "task_created",
              taskId: payload,
              timestamp: new Date().toISOString(),
            }),
          );
          return;
        }
        // new_task notifications are just a task UUID. Resolve the hiveId
        // via a lookup; if it doesn't match, drop.
        void (async () => {
          try {
            const rows = await listener<{ hive_id: string }[]>`
              SELECT hive_id FROM tasks WHERE id = ${payload}::uuid LIMIT 1
            `;
            if (rows[0]?.hive_id === hiveId) {
              sendEvent(
                JSON.stringify({
                  type: "task_created",
                  taskId: payload,
                  timestamp: new Date().toISOString(),
                }),
              );
            }
          } catch {
            /* task vanished or DB blip — drop */
          }
        })();
      });

      request.signal.addEventListener("abort", () => {
        void cleanup?.();
      });
    },
    cancel() {
      void cleanup?.();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
