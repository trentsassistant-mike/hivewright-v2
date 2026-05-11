/**
 * GET /api/goals/:id/stream
 *
 * Server-Sent Events endpoint that aggregates real-time adapter output for
 * ALL tasks belonging to a goal. A single goal may run multiple tasks (one
 * per sprint slot), so the stream fans in output from each of them.
 *
 * ──────────────────────────────────────────────────────────
 * DATA FLOW
 * ──────────────────────────────────────────────────────────
 *   Dispatcher process
 *     └─ writeTaskLog(sql, { taskId, goalId, chunk, type })
 *         ├─ INSERT INTO task_logs
 *         ├─ pg_notify('task_output:<taskId>', JSON)   ← task stream
 *         └─ pg_notify('goal_output:<goalId>', JSON)   ← this endpoint
 *
 *   Next.js process (this file)
 *     └─ LISTEN 'goal_output:<goalId>'
 *         └─ SSE → browser
 *
 * ──────────────────────────────────────────────────────────
 * SSE EVENT SHAPE
 * ──────────────────────────────────────────────────────────
 * Identical to the task stream except the JSON payload also carries `goalId`
 * and the "connected" event uses `goalId` instead of `taskId`.
 *
 * Log event JSON fields:
 *   goalId    string  — UUID of the goal (same for all events on this stream)
 *   taskId    string  — UUID of the task that produced this chunk
 *   chunk     string  — text content (empty for "done" type)
 *   type      string  — "stdout" | "stderr" | "status" | "diagnostic" | "done"
 *   id        number  — bigint DB row id; use as Last-Event-ID cursor
 *   timestamp string  — ISO 8601 UTC
 *
 * "connected" event JSON fields:
 *   type      "connected"
 *   goalId    string
 *   timestamp string
 *
 * ──────────────────────────────────────────────────────────
 * REPLAY QUERY
 * ──────────────────────────────────────────────────────────
 * SELECT tl.id, tl.task_id, tl.chunk, tl.type, tl.timestamp
 * FROM task_logs tl
 * JOIN tasks t ON t.id = tl.task_id
 * WHERE t.goal_id = $1 AND tl.id > $2
 * ORDER BY tl.id ASC
 *
 * The bigserial `id` column provides a strict total order across all tasks
 * within a goal — no per-task sequencing needed.
 *
 * ──────────────────────────────────────────────────────────
 * RECONNECT / Last-Event-ID
 * ──────────────────────────────────────────────────────────
 * Same semantics as the task stream: the browser EventSource sends
 * Last-Event-ID on reconnect; the server replays id > lastEventId and then
 * transitions to live. No duplicates because the id is globally unique across
 * the task_logs table.
 *
 * ──────────────────────────────────────────────────────────
 * STREAM TERMINATION
 * ──────────────────────────────────────────────────────────
 * The goal stream does NOT auto-close on "done" events because a goal may
 * run multiple tasks sequentially (one per sprint). Each task emits its own
 * "done" chunk; those are forwarded to the client as informational markers.
 * The stream stays open until the client disconnects.
 */

import postgres from "postgres";
import { sql } from "../../../_lib/db";
import { requireApiUser } from "../../../_lib/auth";
import { jsonError } from "../../../_lib/responses";
import { canAccessHive } from "@/auth/users";

const DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://hivewright@localhost:5432/hivewrightv2";

interface GoalLiveChunk {
  goalId: string;
  taskId: string;
  chunk: string;
  type: "stdout" | "stderr" | "status" | "diagnostic" | "done";
  id: number;
  timestamp: string;
}

interface DbRow {
  id: number | bigint;
  task_id: string;
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

  const { id: goalId } = await params;
  const [goal] = await sql<{ hive_id: string }[]>`
    SELECT hive_id FROM goals WHERE id = ${goalId}
  `;
  if (!goal) return jsonError("Goal not found", 404);
  if (!authz.user.isSystemOwner) {
    const hasAccess = await canAccessHive(sql, authz.user.id, goal.hive_id);
    if (!hasAccess) return jsonError("Forbidden: caller cannot access this goal", 403);
  }

  // Last-Event-ID header: last successfully received chunk id (0 = none yet).
  const lastEventIdHeader = request.headers.get("last-event-id");
  const lastEventId = lastEventIdHeader ? parseInt(lastEventIdHeader, 10) : 0;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object, id?: number) => {
        let frame = "";
        if (id !== undefined) frame += `id: ${id}\n`;
        frame += `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(frame));
      };

      let closed = false;
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
      const pendingLive: GoalLiveChunk[] = [];
      let liveReady = false;

      subscription = await listenClient.listen(
        `goal_output:${goalId}`,
        (payload: string) => {
          if (closed) return;
          try {
            const chunk = JSON.parse(payload) as GoalLiveChunk;
            if (!liveReady) {
              pendingLive.push(chunk);
            } else {
              // Goal stream does not auto-close on "done" — a goal may have
              // multiple sequential tasks. The "done" event is forwarded as an
              // informational marker so the UI can reset its per-task display.
              send(chunk, chunk.id);
            }
          } catch { /* malformed payload — ignore */ }
        },
      );

      // ── Step 2: Send the synthetic "connected" event ──────────────────────
      send({ type: "connected", goalId, timestamp: new Date().toISOString() });

      // ── Step 3: Replay historical chunks from task_logs ───────────────────
      // JOIN tasks to filter only rows that belong to this goal.
      let lastReplayedId = lastEventId;
      try {
        const rows = (await sql.unsafe(
          `SELECT tl.id, tl.task_id, tl.chunk, tl.type, tl.timestamp
           FROM task_logs tl
           JOIN tasks t ON t.id = tl.task_id
           WHERE t.goal_id = $1 AND tl.id > $2
           ORDER BY tl.id ASC`,
          [goalId, lastEventId],
        )) as unknown as DbRow[];

        for (const row of rows) {
          if (closed) break;
          const id = Number(row.id);
          const taskId = row.task_id;
          const timestamp =
            row.timestamp instanceof Date
              ? row.timestamp.toISOString()
              : String(row.timestamp);
          send({ goalId, taskId, chunk: row.chunk, type: row.type, id, timestamp }, id);
          lastReplayedId = id;
        }
      } catch { /* DB unavailable — fall through to live-only mode */ }

      // ── Step 4: Drain buffered live chunks (deduplicate) ──────────────────
      for (const chunk of pendingLive) {
        if (closed) break;
        if (chunk.id > lastReplayedId) {
          send(chunk, chunk.id);
          lastReplayedId = chunk.id;
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
