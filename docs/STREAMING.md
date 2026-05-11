# Live Agent Activity Streaming

**Status**: Implemented (task stream: sprint 2026-04-09; goal stream: sprint 2026-04-09 rework)  
**Architecture decision**: pg_notify + task_logs DB persistence (Option C)  
**Next sprint**: See [Handover Notes](#handover-notes) at the bottom.

---

## Overview

Agent output is streamed in real-time from the dispatcher process to the browser
via Server-Sent Events (SSE). The dispatcher runs adapters in a separate Node.js
process from the Next.js web server, so in-memory pub/sub (the previous
`outputBuffer` approach) cannot work across that process boundary. The correct
mechanism is:

1. **Dispatcher** → writes each chunk to `task_logs` (INSERT) and broadcasts via
   `pg_notify('task_output:<taskId>', JSON)`.
2. **Next.js SSE route** → LISTENs on that channel and forwards chunks to
   connected browser clients.
3. **Late-joining / reconnecting clients** → replay from `task_logs` using the
   `Last-Event-ID` cursor, then transition to live pg_notify.

---

## Endpoints

Two SSE endpoints are provided — one scoped to a single task, one that
aggregates all tasks belonging to a goal.

| Endpoint | Scope | Closes on `"done"`? |
|----------|-------|---------------------|
| `GET /api/tasks/:id/stream` | Single task | Yes — stream closes after the task's terminal `"done"` chunk |
| `GET /api/goals/:id/stream` | All tasks in a goal | No — a goal runs multiple sequential tasks; `"done"` is forwarded as an informational marker |

---

## Task Stream Contract

### Request

```
GET /api/tasks/:id/stream
```

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `id` | URL path | UUID string | yes | Task ID to stream output for |
| `Last-Event-ID` | Request header | integer string | no | Last chunk id received; server replays from id+1. Sent automatically by browser EventSource on reconnect. |

### Response

```
HTTP 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

The response body is a stream of SSE frames. Each frame is terminated by a
blank line (`\n\n`).

---

## SSE Event Structure

### Frame wire format

```
id: <integer>\n
data: <JSON>\n
\n
```

The `id:` line is omitted on the synthetic `"connected"` event because that
event carries no DB row id.

### JSON payload — log events (type ≠ "connected")

| Field | Type | Description |
|-------|------|-------------|
| `taskId` | `string` | UUID of the task (e.g. `"b3f1a2d4-…"`) |
| `chunk` | `string` | Text content of this chunk. Empty string `""` for `"done"` type. May contain newlines. Truncated to 7000 chars if the dispatcher's pg_notify payload would otherwise exceed 8000 bytes. |
| `type` | `"stdout" \| "stderr" \| "status" \| "done"` | Chunk kind (see table below) |
| `id` | `number` | Bigint DB row id cast to JS number. Mirrors the SSE `id:` field. Use as `Last-Event-ID` cursor. |
| `timestamp` | `string` | ISO 8601 UTC timestamp assigned at write time (e.g. `"2026-04-09T12:34:56.789Z"`) |

### JSON payload — connection event

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"connected"` | Synthetic event; no DB row. |
| `taskId` | `string` | UUID of the task |
| `timestamp` | `string` | ISO 8601 UTC timestamp |

### Chunk types

| `type` | When emitted | `chunk` content |
|--------|-------------|-----------------|
| `"status"` | Task lifecycle: "Starting task: …" at begin | Human-readable status message |
| `"stdout"` | Each `data` event on adapter's stdout | Raw stdout text (may be partial line) |
| `"stderr"` | Each `data` event on adapter's stderr | Raw stderr text |
| `"done"` | After adapter process exits and all chunks are flushed | Always `""` (empty string) |
| `"connected"` | Immediately on SSE connection (synthetic) | N/A — not a DB row |

The `"done"` event signals end-of-stream. Clients should close the EventSource
after receiving it.

### Example SSE transcript

```
data: {"type":"connected","taskId":"abc123","timestamp":"2026-04-09T12:00:00.000Z"}

id: 1
data: {"taskId":"abc123","chunk":"Starting task: Implement feature X","type":"status","id":1,"timestamp":"2026-04-09T12:00:00.010Z"}

id: 2
data: {"taskId":"abc123","chunk":"Reading codebase…\n","type":"stdout","id":2,"timestamp":"2026-04-09T12:00:01.234Z"}

id: 3
data: {"taskId":"abc123","chunk":"warning: deprecated API\n","type":"stderr","id":3,"timestamp":"2026-04-09T12:00:02.100Z"}

id: 47
data: {"taskId":"abc123","chunk":"","type":"done","id":47,"timestamp":"2026-04-09T12:00:58.999Z"}
```

---

## Goal Stream Contract

### Request

```
GET /api/goals/:id/stream
```

| Parameter | Location | Type | Required | Description |
|-----------|----------|------|----------|-------------|
| `id` | URL path | UUID string | yes | Goal ID |
| `Last-Event-ID` | Request header | integer string | no | Last chunk id received across any task in this goal; replays from id+1. |

### Response

Same headers as the task stream (`text/event-stream`, `no-cache`, `keep-alive`).

### SSE Event Structure

Log event JSON fields (identical to task stream plus `goalId`):

| Field | Type | Description |
|-------|------|-------------|
| `goalId` | `string` | UUID of the goal (constant for all events on this stream) |
| `taskId` | `string` | UUID of the specific task that produced this chunk |
| `chunk` | `string` | Text content (empty `""` for `"done"` type) |
| `type` | `"stdout" \| "stderr" \| "status" \| "done"` | Chunk kind |
| `id` | `number` | Bigint DB row id; use as `Last-Event-ID` cursor |
| `timestamp` | `string` | ISO 8601 UTC |

"connected" event fields: `type: "connected"`, `goalId`, `timestamp`.

### Fan-in and Ordering

The goal stream aggregates rows from `task_logs` across all tasks where
`tasks.goal_id = :goalId`. The `id` column (bigserial) provides a strict
total order across tasks — no per-task sequencing is required. A client
reconnecting with `Last-Event-ID: n` receives all rows where `id > n`,
regardless of which task produced them.

### Stream Termination

The goal stream does **not** auto-close on `"done"` events. A goal executes
multiple tasks sequentially (one sprint per task batch), so each task emits
its own `"done"` chunk. The stream stays open until the client disconnects or
the server is restarted. Clients should apply a 5-minute idle timeout (same
recommendation as the task stream).

### Replay Query

```sql
SELECT tl.id, tl.task_id, tl.chunk, tl.type, tl.timestamp
FROM task_logs tl
JOIN tasks t ON t.id = tl.task_id
WHERE t.goal_id = $1 AND tl.id > $2
ORDER BY tl.id ASC
```

### pg_notify Channel

`goal_output:<goalId>` — fired by `writeTaskLog()` whenever the chunk's
`goalId` field is non-null. Payload shape:

```json
{
  "goalId": "<uuid>",
  "taskId": "<uuid>",
  "chunk": "<text, truncated to 7000 chars>",
  "type": "stdout",
  "id": 42,
  "timestamp": "2026-04-09T12:00:00.000Z"
}
```

---

## Ordering Guarantees

1. **Strict total order within a task**: rows in `task_logs` are ordered by
   `id ASC` (bigserial). The SSE endpoint replays them in that order.
2. **No gaps**: The LISTEN subscription is established *before* the DB replay
   query runs. Any pg_notify fired in the window between those two operations is
   buffered in memory and drained after replay, deduplicated by `id >
   lastReplayedId`. Clients never receive duplicate or out-of-order chunks.
3. **pg_notify payload cap**: chunk text is truncated to 7000 chars before
   serialisation. The full text is always in `task_logs`; if a chunk was
   truncated in transit, a reconnect will replay the full row from DB.
4. **Single writer per task**: chunks are written by one dispatcher worker per
   task. There is no concurrent-write race on the sequence.

---

## Failure and Reconnect Behaviour

### Client reconnect (browser EventSource)

`EventSource` automatically reconnects on network errors and sends the
`Last-Event-ID` header equal to the last `id:` value it received.

No additional client-side reconnect logic is needed. The built-in behaviour is:

1. Connection drops.
2. Browser waits the SSE `retry:` interval (default 3 s; server does not
   currently override this).
3. Browser reopens `GET /api/tasks/:id/stream` with header
   `Last-Event-ID: <lastId>`.
4. Server replays `task_logs WHERE id > lastId ORDER BY id ASC`, then goes live.

If `Last-Event-ID` is absent (first connect), the server replays **all** rows
for the task, then goes live.

### Server-side: dispatcher process dies mid-task

The watchdog in `src/dispatcher/watchdog.ts` detects heartbeat timeouts and
marks tasks as `failed`. The SSE stream will remain open waiting for a
`"done"` chunk that never comes. Clients should apply a timeout:

```javascript
// Recommended: close stream if no event in 5 minutes
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
let idleTimer = setTimeout(() => es.close(), IDLE_TIMEOUT_MS);
es.onmessage = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => es.close(), IDLE_TIMEOUT_MS);
};
```

### Server-side: Next.js process restarts mid-stream

The LISTEN connection (one per SSE subscriber) is dropped. The browser
EventSource reconnects automatically with `Last-Event-ID`. The new SSE handler
replays from task_logs, picking up exactly where the client left off.

### Server-side: pg_notify missed (postgres connection hiccup)

postgres.js automatically re-establishes LISTEN connections. In the gap,
the client's stream is silently stalled (no error). On Next.js restart or
explicit reconnect, task_logs replay fills the gap.

### task_logs cleanup

Rows are **not automatically purged** (no cleanup job exists yet — see handover
notes). They accumulate indefinitely. Plan a cleanup cron that deletes rows for
tasks completed more than 24 hours ago.

---

## Client Usage

```typescript
const taskId = "b3f1a2d4-…";

const es = new EventSource(`/api/tasks/${taskId}/stream`);

es.onmessage = (event) => {
  const chunk = JSON.parse(event.data) as {
    taskId: string;
    chunk: string;
    type: "stdout" | "stderr" | "status" | "done" | "connected";
    id?: number;
    timestamp: string;
  };

  if (chunk.type === "connected") return; // ignore synthetic event

  if (chunk.type === "done") {
    es.close();
    return;
  }

  // append chunk.chunk to your UI
};

es.onerror = () => {
  // EventSource reconnects automatically — no action needed here.
  // Last-Event-ID is sent by the browser on reconnect.
};
```

---

## Architecture Diagram

```
┌─────────────────────────────────┐     ┌─────────────────────────────────┐
│  dispatcher (separate process)  │     │  Next.js (web server process)   │
│                                 │     │                                 │
│  task claimed                   │     │  GET /api/tasks/:id/stream      │
│    │                            │     │    │                            │
│    ▼                            │     │    ├─ LISTEN task_output:<id>   │
│  adapter.execute(ctx, onChunk)  │     │    │                            │
│    │ stdout data event          │     │    ├─ SELECT task_logs          │
│    ▼                            │     │    │   WHERE id > lastEventId   │
│  writeTaskLog()                 │     │    │   ORDER BY id ASC          │
│    ├─ INSERT task_logs          │─────┤    │                            │
│    └─ pg_notify(               │  PG │    └─ SSE frames → browser      │
│         task_output:<id>,       │     │         id: <row.id>            │
│         JSON)                   │─────┤         data: JSON              │
└─────────────────────────────────┘     └─────────────────────────────────┘
                                                        │
                                               ┌────────┘
                                               ▼
                                         browser EventSource
                                           Last-Event-ID: <n>
                                           (auto-reconnect)
```

---

## Files Changed

### Sprint 2026-04-09 (task stream)

| File | Change |
|------|--------|
| `src/db/schema/task-logs.ts` | **New** — Drizzle schema for `task_logs` table |
| `src/db/schema/index.ts` | Export `task-logs` |
| `drizzle/0006_task_logs.sql` | **New** — Migration: CREATE TABLE task_logs, index, FK |
| `src/dispatcher/task-log-writer.ts` | **New** — INSERT + pg_notify helper |
| `src/adapters/types.ts` | Added `ChunkCallback` type; added `onChunk?` param to `Adapter.execute()` |
| `src/adapters/claude-code.ts` | Streams stdout/stderr chunks via `onChunk`; awaits all promises before resolve |
| `src/adapters/openclaw.ts` | Same streaming pattern as claude-code |
| `src/dispatcher/index.ts` | Writes "status" start chunk; passes `onChunk` to `adapter.execute()`; writes "done" chunk after |
| `src/app/api/tasks/[id]/stream/route.ts` | Replaced in-memory outputBuffer with pg LISTEN + task_logs replay |

### Sprint 2026-04-09 rework (goal stream)

| File | Change |
|------|--------|
| `src/dispatcher/task-log-writer.ts` | Added `goalId?` to `LogChunk`; fires second `pg_notify` on `goal_output:<goalId>` when set |
| `src/dispatcher/index.ts` | Threads `task.goalId` into all three `writeTaskLog` calls |
| `src/app/api/goals/[id]/stream/route.ts` | **New** — Goal SSE endpoint: LISTEN `goal_output:<goalId>`, replay via JOIN query |
| `src/dispatcher/task-log-writer.test.ts` | **New** — Unit tests: INSERT, task_output notify, goal_output notify, truncation |
| `src/app/api/goals/[id]/stream/route.test.ts` | **New** — Route tests: initial backfill, live append, reconnect dedup, multi-task fan-in |

---

## Contract Verification

This section maps each contract claim to the source code that implements it.
Reviewers can confirm the spec matches reality without running the system.

### Endpoint path and method

**Claim:** `GET /api/tasks/:id/stream`  
**Code:** `src/app/api/tasks/[id]/stream/route.ts:77` — `export async function GET`

### Response headers

**Claim:** `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`  
**Code:** `src/app/api/tasks/[id]/stream/route.ts:195-200`

### SSE frame format: `id:` line present on log events, absent on `"connected"`

**Claim:** Each log event carries `id: <integer>` as the SSE `id:` line. The
synthetic `"connected"` event has no `id:` line.  
**Code:** `src/app/api/tasks/[id]/stream/route.ts:96-101` — `send()` helper:
`if (id !== undefined) frame += \`id: ${id}\n\``; the `"connected"` event is
sent via `send({...})` with no second argument at line 140.

### JSON payload fields

**Claim:** Log events carry `taskId`, `chunk`, `type`, `id`, `timestamp`.  
**Code:** `src/dispatcher/task-log-writer.ts:59-65` — payload object constructed with all five fields;
`src/app/api/tasks/[id]/stream/route.ts:162` — DB replay sends the same shape.

**Claim:** `"connected"` event carries `type`, `taskId`, `timestamp` only.  
**Code:** `src/app/api/tasks/[id]/stream/route.ts:140`

### Chunk types

**Claim:** `"status"` is written once at task start with a human-readable message.  
**Code:** `src/dispatcher/index.ts:254-258` — `writeTaskLog(... { chunk: \`Starting task: ${task.title}\`, type: "status" })`

**Claim:** `"stdout"` / `"stderr"` arrive from the adapter subprocess `data` events.  
**Code:** `src/adapters/claude-code.ts:100-114`; `src/adapters/openclaw.ts:149-163`

**Claim:** `"done"` is always written after `execute()` resolves; `chunk` is always `""`.  
**Code:** `src/dispatcher/index.ts:279-281` — written immediately after `await adapter.execute()` returns; `chunk: ""`

### pg_notify truncation at 7000 chars

**Claim:** `chunk` text is truncated to 7000 chars in the pg_notify payload;
full text is stored untruncated in `task_logs`.  
**Code:** `src/dispatcher/task-log-writer.ts:61` — `data.chunk.slice(0, 7000)` applied
inside the `payload` JSON only; the `INSERT` at line 43-47 uses `data.chunk` unmodified.

### Replay on initial connect (Last-Event-ID absent)

**Claim:** Server replays all rows for the task starting from `id = 1`.  
**Code:** `src/app/api/tasks/[id]/stream/route.ts:84-85` — `lastEventId`
defaults to `0` when the header is absent; query at line 150-152 is `id > $2`.

### Replay on reconnect (Last-Event-ID present)

**Claim:** Server replays only rows with `id > lastEventId`.  
**Code:** `src/app/api/tasks/[id]/stream/route.ts:84-85` (parse header);
`src/app/api/tasks/[id]/stream/route.ts:150-152` (query uses parsed value).

### Race-condition guard: LISTEN before replay

**Claim:** LISTEN is established before the DB replay query, so no chunk is
lost in the window between the two operations.  
**Code:** `src/app/api/tasks/[id]/stream/route.ts:123-137` — LISTEN subscribed and
`pendingLive` buffer set up; `src/app/api/tasks/[id]/stream/route.ts:147-169` — DB
replay runs after; `src/app/api/tasks/[id]/stream/route.ts:175-186` — `pendingLive`
drained after replay.

### Deduplication of pendingLive buffer

**Claim:** Chunks buffered during the replay window are emitted only if
`id > lastReplayedId`, preventing double-delivery.  
**Code:** `src/app/api/tasks/[id]/stream/route.ts:177` — `if (chunk.id > lastReplayedId)`

### Single writer per task

**Claim:** Only one dispatcher worker writes chunks for a given task at a time.  
**Code:** `src/dispatcher/task-claimer.ts` — task status set to `"active"` with
`dispatcherPid` before execution begins; subsequent claim attempts skip active tasks.

### Stream closure on `"done"`

**Claim:** The SSE stream is closed server-side after emitting the `"done"` chunk.  
**Code:** `src/app/api/tasks/[id]/stream/route.ts:133` (live pg_notify path) and
`src/app/api/tasks/[id]/stream/route.ts:164-167` (replay path) — `void close()`
called immediately after the `"done"` event is forwarded.

### Authentication

**Claim (gap):** The endpoint currently has no authentication gate.  
**Code:** `src/app/api/tasks/[id]/stream/route.ts` — no session/token check present.  
**Risk:** Any client with network access can stream output for any task by UUID.
Task IDs are UUIDs (128-bit entropy), which limits exposure. Add session auth in a
future sprint (see Handover Notes item 7).

---

## Handover Notes

### What works now

- Every task execution (ClaudeCode and OpenClaw adapters) writes chunks to
  `task_logs` and broadcasts via `pg_notify`.
- `GET /api/tasks/:id/stream` streams those chunks over SSE with correct
  ordering, replay on reconnect, and race-condition protection. Closes on `"done"`.
- `GET /api/goals/:id/stream` aggregates output across all tasks in a goal,
  using the same LISTEN+replay pattern. Does not auto-close (goal runs multiple tasks).
- `writeTaskLog` fires both `task_output:<taskId>` and `goal_output:<goalId>`
  when a goalId is available; dispatcher threads goalId from the task record.
- 10 automated tests cover: DB insert, task notify, goal notify, chunk truncation,
  initial backfill, live append, reconnect dedup, multi-task fan-in.

### What the next sprint needs to do

1. **UI: simplify deduplication to use `id`** *(done — dedup updated this sprint)*  
   `LiveActivityPanel` (`src/components/live-activity-panel.tsx`) is wired to
   `/api/tasks/:id/stream`. The dedup key now uses the server-assigned `id`
   (number), which is strictly increasing and unique per task. The fallback to
   `timestamp::type::chunk-prefix` is kept only for the synthetic `"connected"`
   event which carries no `id`.

2. **task_logs cleanup cron**  
   Add a periodic job (suggest: dispatcher synthesis timer or a new cron) that
   deletes `task_logs` rows for tasks completed more than 24 hours ago:
   ```sql
   DELETE FROM task_logs
   WHERE task_id IN (
     SELECT id FROM tasks
     WHERE status IN ('completed','failed')
       AND completed_at < NOW() - INTERVAL '24 hours'
   );
   ```

3. **Idle-stream timeout on the client**  
   If the dispatcher dies mid-task, the SSE stream stalls indefinitely. Add a
   5-minute idle timeout to the UI component (see Client Usage section above).

4. **Verify the dispatcher DATABASE_URL is consistent**  
   `src/dispatcher/index.ts` hardcodes `postgresql://hivewright@localhost:5432/hivewrightv2`
   at the top. `task-log-writer.ts` uses the same `sql` instance passed in as a
   parameter. No change needed; just confirm `.env` is loaded correctly in the
   dispatcher before running.

5. **Test the full round-trip**  
   Start a task that uses the ClaudeCode adapter. Open the SSE stream in a
   browser DevTools → Network tab. Confirm you see `stdout` chunks arriving
   in real-time before the task completes. Then kill the browser tab, wait a
   few seconds, and reconnect — confirm the replay from `Last-Event-ID = 0`
   returns all historical chunks.

6. **Ollama adapter**  
   `src/adapters/ollama.ts` was not updated in this sprint. If Ollama tasks
   need live streaming, apply the same `onChunk` pattern (same as claude-code
   and openclaw).
