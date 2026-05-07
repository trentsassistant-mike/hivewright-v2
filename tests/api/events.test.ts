import { describe, it, expect } from "vitest";
import { emitTaskEvent } from "@/dispatcher/event-emitter";
import { testSql as sql } from "../_lib/test-db";

describe("emitTaskEvent", () => {
  it("sends a NOTIFY on the task_events channel", async () => {
    const received: string[] = [];
    await sql.listen("task_events", (payload) => { received.push(payload); });
    await emitTaskEvent(sql, { type: "task_completed", taskId: "test-123", title: "Test task", assignedTo: "dev-agent" });
    await new Promise((r) => setTimeout(r, 200));
    expect(received.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(received[0]);
    expect(parsed.type).toBe("task_completed");
    expect(parsed.taskId).toBe("test-123");
    expect(parsed.timestamp).toBeDefined();
  });
});
