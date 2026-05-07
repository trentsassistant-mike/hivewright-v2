import { describe, it, expect, beforeEach, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

// Point the voice adapter at the test DB instead of the prod default.
// Every other EA module takes `sql` as a parameter, but the voice-adapter
// owns its own DB handle (matching the pattern used by HTTP route
// handlers), so we rewire that handle to the shared test pool here.
vi.mock("@/app/api/_lib/db", () => ({ sql }));

// Stub out the real prompt builder — it runs ~6 queries against live
// hive state. We only need to assert voice-turn persistence, so a
// deterministic string keeps this isolated from the prompt surface.
vi.mock("@/ea/native/prompt", () => ({
  buildEaPrompt: async () => "STUB PROMPT",
}));

// Stub the streaming runner so we never spawn a `claude` subprocess.
// Yields three deltas that the adapter should concatenate verbatim.
vi.mock("@/ea/native/runner", () => ({
  runEaStream: async function* () {
    yield "Hello";
    yield ", ";
    yield "Trent.";
  },
  runEa: async () => ({ success: true, text: "" }),
}));

import { eaVoiceClient } from "@/ea/native/voice-adapter";
import { VOICE_MODE_PROMPT_SUFFIX } from "@/connectors/voice/prompt";

const HIVE_ID = "66666666-6666-6666-6666-666666666666";
const SESSION_ID = "77777777-7777-7777-7777-777777777777";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'vb', 'Voice Biz', 'digital')
  `;
  await sql`
    INSERT INTO voice_sessions (id, hive_id)
    VALUES (${SESSION_ID}, ${HIVE_ID})
  `;
});

describe("eaVoiceClient.submit", () => {
  it("streams EA chunks and persists both turns to ea_messages", async () => {
    const stream = await eaVoiceClient.submit("Hey, what's up?", {
      sessionId: SESSION_ID,
      hiveId: HIVE_ID,
    });

    const chunks: string[] = [];
    for await (const c of stream) chunks.push(c);

    expect(chunks).toEqual(["Hello", ", ", "Trent."]);
    expect(chunks.join("")).toBe("Hello, Trent.");

    const rows = await sql<
      {
        role: string;
        content: string;
        source: string;
        voice_session_id: string | null;
      }[]
    >`
      SELECT m.role, m.content, m.source, m.voice_session_id
      FROM ea_messages m
      JOIN ea_threads t ON t.id = m.thread_id
      WHERE t.hive_id = ${HIVE_ID}
        AND t.channel_id = ${`voice:${SESSION_ID}`}
      ORDER BY m.created_at ASC
    `;

    expect(rows).toHaveLength(2);
    expect(rows[0].role).toBe("owner");
    expect(rows[0].content).toBe("Hey, what's up?");
    expect(rows[0].source).toBe("voice");
    expect(rows[0].voice_session_id).toBe(SESSION_ID);

    expect(rows[1].role).toBe("assistant");
    expect(rows[1].content).toBe("Hello, Trent.");
    expect(rows[1].source).toBe("voice");
    expect(rows[1].voice_session_id).toBe(SESSION_ID);
  });

  it("reuses the same voice thread across multiple turns in a session", async () => {
    const first = await eaVoiceClient.submit("first", {
      sessionId: SESSION_ID,
      hiveId: HIVE_ID,
    });
    for await (const chunk of first) {
      void chunk;
    }

    const second = await eaVoiceClient.submit("second", {
      sessionId: SESSION_ID,
      hiveId: HIVE_ID,
    });
    for await (const chunk of second) {
      void chunk;
    }

    const [threadCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM ea_threads
      WHERE hive_id = ${HIVE_ID}
        AND channel_id = ${`voice:${SESSION_ID}`}
    `;
    expect(threadCount.count).toBe("1");

    const [msgCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM ea_messages m
      JOIN ea_threads t ON t.id = m.thread_id
      WHERE t.hive_id = ${HIVE_ID}
        AND t.channel_id = ${`voice:${SESSION_ID}`}
    `;
    // 2 owner + 2 assistant = 4
    expect(msgCount.count).toBe("4");
  });

  it("exports the voice-mode prompt suffix with the expected contract keywords", () => {
    // Guard against accidental deletion of the voice-mode rules the EA
    // is trained to follow — the plan text is load-bearing for tone.
    expect(VOICE_MODE_PROMPT_SUFFIX).toContain("Voice Mode");
    expect(VOICE_MODE_PROMPT_SUFFIX).toContain("Three response modes");
    expect(VOICE_MODE_PROMPT_SUFFIX).toContain("AirPods");
  });
});
