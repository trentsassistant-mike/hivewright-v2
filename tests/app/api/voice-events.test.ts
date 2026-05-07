import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../../_lib/test-db";
import { GET } from "@/app/api/voice/sessions/[id]/events/route";

const HIVE_ID = "00000000-0000-0000-0000-000000000001";
const SESSION_ID = "00000000-0000-0000-0000-000000000010";

async function seed() {
  await truncateAll(sql);
  await sql`INSERT INTO hives (id, slug, name, type) VALUES (${HIVE_ID}, 'test', 'Test', 'real')`;
  await sql`INSERT INTO voice_sessions (id, hive_id) VALUES (${SESSION_ID}, ${HIVE_ID})`;
  await sql`INSERT INTO voice_session_events (session_id, kind, text) VALUES (${SESSION_ID}, 'user_phrase', 'hey ea')`;
  await sql`INSERT INTO voice_session_events (session_id, kind, text) VALUES (${SESSION_ID}, 'ea_phrase', 'hi trent')`;
}

describe("GET /api/voice/sessions/[id]/events", () => {
  beforeEach(async () => {
    await seed();
  });

  it("emits SSE frames for user_phrase and ea_phrase events", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    const req = new Request(
      `http://localhost/api/voice/sessions/${SESSION_ID}/events`,
      { signal: abort.signal },
    );
    const res = await GET(req, {
      params: Promise.resolve({ id: SESSION_ID }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = res.body!;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes("event: ea_phrase")) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    expect(text).toContain("event: user_phrase");
    expect(text).toContain("event: ea_phrase");
  }, 10_000);
});
