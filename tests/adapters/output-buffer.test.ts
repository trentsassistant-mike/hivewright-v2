import { describe, it, expect, beforeEach } from "vitest";
import { outputBuffer, mockStreamingExecution, type OutputChunk } from "@/adapters/output-buffer";

// Reset buffer state between tests by clearing any task data
beforeEach(() => {
  outputBuffer.clear("test-task-001");
  outputBuffer.clear("test-task-002");
  outputBuffer.clear("mock-task-abc");
});

describe("OutputBufferRegistry", () => {
  it("buffers pushed chunks and replays them for late subscribers", () => {
    outputBuffer.push({ taskId: "test-task-001", chunk: "Starting...", type: "stdout", timestamp: new Date().toISOString() });
    outputBuffer.push({ taskId: "test-task-001", chunk: "Done.", type: "done", timestamp: new Date().toISOString() });

    const buffered = outputBuffer.getChunks("test-task-001");
    expect(buffered).toHaveLength(2);
    expect(buffered[0].chunk).toBe("Starting...");
    expect(buffered[1].type).toBe("done");
  });

  it("delivers chunks to live subscribers immediately on push", () => {
    const received: OutputChunk[] = [];
    const unsub = outputBuffer.subscribe("test-task-001", (c) => received.push(c));

    outputBuffer.push({ taskId: "test-task-001", chunk: "live chunk", type: "stdout", timestamp: new Date().toISOString() });

    unsub();
    expect(received).toHaveLength(1);
    expect(received[0].chunk).toBe("live chunk");
  });

  it("does not deliver chunks to unsubscribed listeners", () => {
    const received: OutputChunk[] = [];
    const unsub = outputBuffer.subscribe("test-task-001", (c) => received.push(c));
    unsub();

    outputBuffer.push({ taskId: "test-task-001", chunk: "after unsub", type: "stdout", timestamp: new Date().toISOString() });

    expect(received).toHaveLength(0);
  });

  it("isolates chunks by taskId — task A does not receive task B chunks", () => {
    const receivedA: OutputChunk[] = [];
    const receivedB: OutputChunk[] = [];
    const unsubA = outputBuffer.subscribe("test-task-001", (c) => receivedA.push(c));
    const unsubB = outputBuffer.subscribe("test-task-002", (c) => receivedB.push(c));

    outputBuffer.push({ taskId: "test-task-001", chunk: "for A", type: "stdout", timestamp: new Date().toISOString() });
    outputBuffer.push({ taskId: "test-task-002", chunk: "for B", type: "stdout", timestamp: new Date().toISOString() });

    unsubA();
    unsubB();

    expect(receivedA).toHaveLength(1);
    expect(receivedA[0].chunk).toBe("for A");
    expect(receivedB).toHaveLength(1);
    expect(receivedB[0].chunk).toBe("for B");
  });

  it("returns empty array for a task with no chunks", () => {
    expect(outputBuffer.getChunks("nonexistent-task")).toEqual([]);
  });

  it("clears buffered chunks and listeners on clear()", () => {
    outputBuffer.push({ taskId: "test-task-001", chunk: "x", type: "stdout", timestamp: new Date().toISOString() });
    outputBuffer.clear("test-task-001");
    expect(outputBuffer.getChunks("test-task-001")).toHaveLength(0);
  });

  it("caps buffer at 1 000 chunks to prevent unbounded memory growth", () => {
    for (let i = 0; i < 1005; i++) {
      outputBuffer.push({ taskId: "test-task-001", chunk: `chunk-${i}`, type: "stdout", timestamp: new Date().toISOString() });
    }
    const chunks = outputBuffer.getChunks("test-task-001");
    expect(chunks.length).toBe(1000);
    // The oldest chunks were evicted; the last chunk should be the most recent
    expect(chunks[chunks.length - 1].chunk).toBe("chunk-1004");
  });
});

describe("mockStreamingExecution — end-to-end data flow", () => {
  it("emits a sequence ending with type 'done' and is received by a subscriber", async () => {
    const received: OutputChunk[] = [];
    const unsub = outputBuffer.subscribe("mock-task-abc", (c) => received.push(c));

    await mockStreamingExecution("mock-task-abc", "Test Task");
    unsub();

    expect(received.length).toBeGreaterThan(0);
    expect(received[received.length - 1].type).toBe("done");
    // Must include at least one stdout chunk
    expect(received.some((c) => c.type === "stdout")).toBe(true);
    // Must include at least one status chunk
    expect(received.some((c) => c.type === "status")).toBe(true);
    // All chunks carry the correct taskId
    expect(received.every((c) => c.taskId === "mock-task-abc")).toBe(true);
  }, 15_000);

  it("late subscriber gets buffered history via getChunks()", async () => {
    // Run mock without a subscriber — simulates 'adapter runs before client connects'
    await mockStreamingExecution("mock-task-abc", "Late Subscriber Task");

    // Late subscriber replays history from buffer
    const history = outputBuffer.getChunks("mock-task-abc");
    expect(history.length).toBeGreaterThan(0);
    expect(history[history.length - 1].type).toBe("done");
  }, 15_000);
});
