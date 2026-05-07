import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { runDeliberation } from "@/board/deliberate";
import type { ChatProvider, ChatRequest, ChatResponse } from "@/llm/types";

const HIVE = "ffffffff-ffff-ffff-ffff-ffffffffffff";

class StubProvider implements ChatProvider {
  readonly id = "ollama" as const;
  public calls: ChatRequest[] = [];
  constructor(private responder: (req: ChatRequest) => string) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    return {
      text: this.responder(req),
      tokensIn: 100,
      tokensOut: 50,
      model: req.model,
      provider: "ollama",
    };
  }
}

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE}, 'board-biz', 'Board Biz', 'digital')
  `;
});

describe("runDeliberation", () => {
  it("runs every board member in order and persists turns + recommendation", async () => {
    const stub = new StubProvider((req) => {
      // Each member's output includes its system-prompt's first word so the
      // test can verify order.
      const first = req.system.split(" ")[2];
      return `${first} response`;
    });

    const result = await runDeliberation(
      sql,
      {
        hiveId: HIVE,
        question: "Should we raise prices?",
      },
      stub,
      "test-model",
    );

    expect(stub.calls.length).toBe(5);
    expect(result.turns.length).toBe(5);
    expect(result.turns[0].memberSlug).toBe("analyst");
    expect(result.turns[4].memberSlug).toBe("chair");
    expect(result.recommendation).toMatch(/response/);

    const [session] = await sql`
      SELECT status, recommendation FROM board_sessions WHERE id = ${result.sessionId}::uuid
    `;
    expect(session.status).toBe("done");
    expect(session.recommendation).toBe(result.recommendation);

    const turns = await sql`
      SELECT member_slug, order_index FROM board_turns
      WHERE session_id = ${result.sessionId}::uuid ORDER BY order_index
    `;
    expect(turns.map((t) => t.member_slug)).toEqual([
      "analyst",
      "strategist",
      "risk",
      "accountant",
      "chair",
    ]);
  });

  it("marks the session as error if a member throws", async () => {
    const stub = new StubProvider((req) => {
      if (req.system.startsWith("You are the Risk")) {
        throw new Error("model rate-limited");
      }
      return "ok";
    });

    await expect(
      runDeliberation(sql, { hiveId: HIVE, question: "Hmm?" }, stub, "m"),
    ).rejects.toThrow(/rate-limited/);

    const [session] = await sql`
      SELECT status, error_text FROM board_sessions WHERE hive_id = ${HIVE}::uuid
    `;
    expect(session.status).toBe("error");
    expect((session.error_text as string)).toMatch(/rate-limited/);
  });
});
