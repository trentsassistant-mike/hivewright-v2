import postgres from "postgres";
import { sql } from "../_lib/db";
import { requireApiUser } from "../_lib/auth";
import { canAccessHive } from "@/auth/users";
import { requireEnv } from "@/lib/required-env";

const DATABASE_URL = requireEnv("DATABASE_URL");

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

      request.signal.addEventListener("abort", async () => {
        closed = true;
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
      });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
