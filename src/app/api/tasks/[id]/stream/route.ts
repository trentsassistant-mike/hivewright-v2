/**
 * GET /api/tasks/:id/stream
 *
 * Server-Sent Events (SSE) endpoint that streams real-time adapter output for
 * a running task. Works across the process boundary between the dispatcher
 * (which runs adapters) and the Next.js web server.
 *
 * ──────────────────────────────────────────────────────────
 * DATA FLOW
 * ──────────────────────────────────────────────────────────
 *   Dispatcher process
 *     └─ adapter stdout/stderr data event
 *         └─ writeTaskLog()
 *             ├─ INSERT INTO task_logs  (durable, replayable)
 *             └─ pg_notify('task_output:<taskId>', JSON)
 *
 *   Next.js process (this file)
 *     └─ LISTEN 'task_output:<taskId>'
 *         └─ SSE → browser
 *
 * ──────────────────────────────────────────────────────────
 * SSE EVENT SHAPE  (see docs/STREAMING.md for full contract)
 * ──────────────────────────────────────────────────────────
 * Each SSE frame:
 *   id: <number>            ← bigint DB row id; used as Last-Event-ID
 *   data: <JSON>\n\n
 *
 * JSON fields on every non-"connected" event:
 *   taskId    string   — UUID of the task
 *   chunk     string   — text content (empty string for "done" type)
 *   type      string   — "stdout" | "stderr" | "status" | "diagnostic" | "done"
 *   id        number   — mirrors the SSE `id:` line value
 *   timestamp string   — ISO 8601 UTC e.g. "2026-04-09T12:00:00.000Z"
 *
 * JSON fields on the synthetic "connected" event (no SSE id line):
 *   type      "connected"
 *   taskId    string
 *   timestamp string
 *
 * ──────────────────────────────────────────────────────────
 * RECONNECT BEHAVIOUR
 * ──────────────────────────────────────────────────────────
 * The browser EventSource automatically sends the `Last-Event-ID` header on
 * reconnect. This endpoint reads that header and replays only rows with
 * id > lastEventId from task_logs, then transitions to live pg_notify.
 * No chunks are lost across reconnects.
 *
 * ──────────────────────────────────────────────────────────
 * RACE-CONDITION GUARD
 * ──────────────────────────────────────────────────────────
 * LISTEN is established before the DB replay query runs. Any pg_notify fired
 * in the window between those two operations is buffered in `pendingLive` and
 * drained after replay, deduplicated by id > lastReplayedId.
 */

import postgres from "postgres";
import { sql } from "../../../_lib/db";
import { requireApiUser } from "../../../_lib/auth";
import { jsonError } from "../../../_lib/responses";
import { canAccessHive } from "@/auth/users";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://hivewright@localhost:5432/hivewrightv2";

interface LiveChunk {
  taskId: string;
  chunk: string;
  type: "stdout" | "stderr" | "status" | "diagnostic" | "done";
  id: number;
  timestamp: string;
}

interface DbRow {
  id: number | bigint;
  chunk: string;
  type: string;
  timestamp: Date | string;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;

  const { id: taskId } = await params;
  const [task] = await sql<{ hive_id: string }[]>`
    SELECT hive_id FROM tasks WHERE id = ${taskId}
  `;
  if (!task) return jsonError("Task not found", 404);
  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, task.hive_id);
    if (!hasAccess) return jsonError("Forbidden: caller cannot access this task", 403);
  }

  // Last-Event-ID header: last successfully received chunk id (0 = none yet).
  const lastEventIdHeader = request.headers.get("last-event-id");
  const lastEventId = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) : 0;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      /**
       * Format a single SSE frame.
       * `id` is included in the frame header so EventSource tracks Last-Event-ID
       * automatically; the browser re-sends it on reconnect without extra code.
       */
      const send = (data: object, id?: number) => {
        let frame = "";
        if (id !== undefined) frame += `id: ${id}\n`;
        frame += `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(frame));
      };

      let closed = false;
      // Dedicated postgres connection for LISTEN (postgres.js requires a
      // reserved connection — LISTEN cannot share a pooled connection).
      const listenClient = postgres(DATABASE_URL, { max: 1 });
      let subscription: { unlisten: () => Promise<void> } | null = null;

      const close = async () => {
        if (closed) return;
        closed = true;
        try { if (subscription) await subscription.unlisten(); } catch { /* ignore */ }
        try { await listenClient.end(); } catch { /* ignore */ }
        try { controller.close(); } catch { /* ignore */ }
      };

      // ── Step 1: Start LISTEN *before* DB replay ───────────────────────────
      // Buffering live notifications here prevents a race window where a chunk
      // arrives after the replay query but before LISTEN is active.
      const pendingLive: LiveChunk[] = [];
      let liveReady = false;

      subscription = await listenClient.listen(
        `task_output:${taskId}`,
        (payload: string) => {
          if (closed) return;
          try {
            const chunk = JSON.parse(payload) as LiveChunk;
            if (!liveReady) {
              pendingLive.push(chunk);
            } else {
              send(chunk, chunk.id);
              if (chunk.type === "done") void close();
            }
          } catch { /* malformed payload — ignore */ }
        },
      );

      // ── Step 2: Send the synthetic "connected" event ──────────────────────
      send({ type: "connected", taskId, timestamp: new Date().toISOString() });

      // ── Step 3: Replay historical chunks from task_logs ───────────────────
      // Only rows newer than the client's Last-Event-ID are sent, enabling
      // gap-free resumption after a network interruption.
      let lastReplayedId = lastEventId;
      try {
        const rows = (await sql.unsafe(
          `SELECT id, chunk, type, timestamp
           FROM task_logs
           WHERE task_id = $1 AND id > $2
           ORDER BY id ASC`,
          [taskId, lastEventId],
        )) as unknown as DbRow[];

        for (const row of rows) {
          if (closed) break;
          const id = Number(row.id);
          const timestamp =
            row.timestamp instanceof Date
              ? row.timestamp.toISOString()
              : String(row.timestamp);
          send({ taskId, chunk: row.chunk, type: row.type, id, timestamp }, id);
          lastReplayedId = id;
          if (row.type === "done") {
            liveReady = true;
            await close();
            return;
          }
        }
      } catch { /* DB unavailable — fall through to live-only mode */ }

      // ── Step 4: Drain buffered live chunks (deduplicate) ──────────────────
      // Any pg_notify that arrived during the replay window is emitted now,
      // skipping ids that were already covered by the DB replay above.
      for (const chunk of pendingLive) {
        if (closed) break;
        if (chunk.id > lastReplayedId) {
          send(chunk, chunk.id);
          lastReplayedId = chunk.id;
          if (chunk.type === "done") {
            liveReady = true;
            await close();
            return;
          }
        }
      }

      liveReady = true;

      // ── Step 5: Handle client disconnect ─────────────────────────────────
      request.signal.addEventListener("abort", () => void close());
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
