import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../../_lib/test-db";
import { GET } from "../../../src/app/api/events/route";

describe("GET /api/events", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("filters pg_notify payloads by ?hiveId=", async () => {
    const bizA = "11111111-1111-1111-1111-111111111111";
    const bizB = "22222222-2222-2222-2222-222222222222";

    const req = new Request(`http://localhost/api/events?hiveId=${bizA}`);
    const res = await GET(req);
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Read first frame ("connected") then emit two events and verify filtering.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const { value: firstChunk } = await reader.read();
    expect(decoder.decode(firstChunk!)).toContain("\"type\":\"connected\"");

    // Wait for the route's two LISTEN commands to be registered with postgres
    // before we fire pg_notify. The route awaits listener.listen(...) internally
    // but postgres-js resolves that promise when the LISTEN command is written to
    // the wire, not when the server acknowledges it — so consumer-side code can't
    // deterministically observe listener readiness. 150ms is comfortably above
    // localhost ACK latency on a loaded CI box. If this ever flakes, raise it.
    await new Promise((r) => setTimeout(r, 150));
    await sql`SELECT pg_notify('task_events', ${JSON.stringify({
      type: "task_claimed",
      taskId: "t-a",
      title: "for biz A",
      assignedTo: "dev-agent",
      hiveId: bizA,
      timestamp: new Date().toISOString(),
    })})`;
    await sql`SELECT pg_notify('task_events', ${JSON.stringify({
      type: "task_claimed",
      taskId: "t-b",
      title: "for biz B",
      assignedTo: "dev-agent",
      hiveId: bizB,
      timestamp: new Date().toISOString(),
    })})`;

    // Collect up to 1s of frames, then abort the request signal.
    const frames: string[] = [];
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 150),
        ),
      ]);
      if (next.done || !next.value) break;
      frames.push(decoder.decode(next.value));
    }

    const combined = frames.join("");
    expect(combined).toContain("for biz A");
    expect(combined).not.toContain("for biz B");

    await reader.cancel();
  });
});
