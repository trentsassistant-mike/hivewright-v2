/**
 * Adapter-level output buffer (PoC implementation).
 *
 * Provides a singleton pub/sub registry that adapters can push output chunks
 * to in real-time. SSE endpoints subscribe to receive those chunks and forward
 * them to connected clients.
 *
 * Architecture note: This in-memory implementation is correct for single-process
 * scenarios (e.g., Next.js dev server + mock). For production — where the
 * dispatcher runs as a separate process — replace push() with a pg_notify call
 * on a per-task channel and subscribe() with a postgres LISTEN, matching the
 * pattern already used in src/dispatcher/event-emitter.ts.
 */

export interface OutputChunk {
  taskId: string;
  /** The text content of this chunk */
  chunk: string;
  /** stdout = normal output, stderr = error output, status = lifecycle message, diagnostic = structured runtime metadata, done = signals end-of-stream */
  type: "stdout" | "stderr" | "status" | "diagnostic" | "done";
  timestamp: string;
}

type ChunkListener = (chunk: OutputChunk) => void;

class OutputBufferRegistry {
  /** Buffered chunks per task (capped at 1 000 to bound memory) */
  private chunks = new Map<string, OutputChunk[]>();
  /** Active SSE subscribers per task */
  private listeners = new Map<string, Set<ChunkListener>>();

  /** Push a chunk from an adapter. Notifies all active subscribers immediately. */
  push(chunk: OutputChunk): void {
    if (!this.chunks.has(chunk.taskId)) {
      this.chunks.set(chunk.taskId, []);
    }
    const buf = this.chunks.get(chunk.taskId)!;
    buf.push(chunk);
    if (buf.length > 1000) buf.shift();

    const taskListeners = this.listeners.get(chunk.taskId);
    if (taskListeners) {
      for (const listener of taskListeners) {
        listener(chunk);
      }
    }
  }

  /**
   * Subscribe to chunks for a task. Returns an unsubscribe function.
   * Call this before starting execution so no chunks are missed.
   */
  subscribe(taskId: string, listener: ChunkListener): () => void {
    if (!this.listeners.has(taskId)) {
      this.listeners.set(taskId, new Set());
    }
    this.listeners.get(taskId)!.add(listener);
    return () => {
      const set = this.listeners.get(taskId);
      if (set) {
        set.delete(listener);
        if (set.size === 0) this.listeners.delete(taskId);
      }
    };
  }

  /** Return all buffered chunks for a task (for late-joining clients). */
  getChunks(taskId: string): OutputChunk[] {
    return this.chunks.get(taskId) ?? [];
  }

  /** Release all state for a task once it is fully complete. */
  clear(taskId: string): void {
    this.chunks.delete(taskId);
    this.listeners.delete(taskId);
  }
}

/**
 * Module-level singleton — one registry per Node.js process.
 * Import this in both adapters (to push) and SSE routes (to subscribe).
 */
export const outputBuffer = new OutputBufferRegistry();

/**
 * Simulate a streaming adapter execution for PoC / demo purposes.
 * Pushes a series of realistic-looking chunks with 400 ms delays, then
 * signals completion with type "done".
 *
 * Usage: GET /api/tasks/:id/stream?mock=true
 */
export async function mockStreamingExecution(
  taskId: string,
  taskTitle: string,
): Promise<void> {
  const steps: Array<{ type: OutputChunk["type"]; text: string }> = [
    { type: "status", text: `Starting task: ${taskTitle}` },
    { type: "stdout", text: "Reading codebase context..." },
    { type: "stdout", text: "Analysing acceptance criteria..." },
    { type: "stdout", text: "Planning implementation approach..." },
    { type: "stdout", text: "Writing implementation..." },
    { type: "stdout", text: "// Example output chunk from adapter\nconst result = compute(input);" },
    { type: "stdout", text: "Running verification steps..." },
    { type: "stdout", text: "All checks passed." },
    { type: "status", text: "Task complete." },
    { type: "done", text: "" },
  ];

  for (const step of steps) {
    outputBuffer.push({
      taskId,
      chunk: step.text,
      type: step.type,
      timestamp: new Date().toISOString(),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
  }
}
