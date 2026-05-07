import { beforeEach, describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  sql: vi.fn(),
  decrypt: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    select: mocks.select,
  },
}));

vi.mock("@/app/api/_lib/db", () => ({
  sql: mocks.sql,
}));

vi.mock("@/credentials/encryption", () => ({
  decrypt: mocks.decrypt,
}));

import {
  buildPostCallSummary,
  postCallSummary,
} from "@/connectors/voice/post-call-summary";

const originalFetch = globalThis.fetch;
const originalEncryptionKey = process.env.ENCRYPTION_KEY;

function mockSelectRows(rows: unknown[]): unknown {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => rows),
        orderBy: vi.fn(async () => rows),
      })),
    })),
  };
}

describe("buildPostCallSummary", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = originalEncryptionKey;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    mocks.select.mockReset();
    mocks.sql.mockReset();
    mocks.decrypt.mockReset();
  });

  it("formats a concise Discord message with duration + transcript", () => {
    const msg = buildPostCallSummary({
      startedAt: new Date("2026-04-23T16:12:00Z"),
      endedAt: new Date("2026-04-23T16:35:04Z"),
      entries: [
        { role: "user", text: "hey check honey-glow" },
        { role: "assistant", text: "on it — all 3 tasks complete" },
      ],
    });
    expect(msg).toContain("Call transcript");
    expect(msg).toContain("23 min 04 sec");
    expect(msg).toContain("You: hey check honey-glow");
    expect(msg).toContain("EA: on it");
  });

  it("truncates when body exceeds Discord 2000-char cap", () => {
    const bigText = "x".repeat(3000);
    const msg = buildPostCallSummary({
      startedAt: new Date("2026-04-23T16:00:00Z"),
      endedAt: new Date("2026-04-23T16:05:00Z"),
      entries: [{ role: "user", text: bigText }],
    });
    expect(msg.length).toBeLessThan(2000);
    expect(msg).toContain("truncated");
  });

  it("formats zero-second calls without NaN", () => {
    const t = new Date();
    const msg = buildPostCallSummary({ startedAt: t, endedAt: t, entries: [] });
    expect(msg).toContain("0 min 00 sec");
    expect(msg).not.toContain("NaN");
  });

  it("claims the session row so concurrent postCallSummary calls only POST once", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.ENCRYPTION_KEY = "test-encryption-key";
    mocks.decrypt.mockReturnValue(JSON.stringify({ botToken: "discord-bot" }));

    let claimed = false;
    const updateResults: number[] = [];
    mocks.sql.mockImplementation(
      async (strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("FROM connector_installs")) {
          return [
            {
              id: "install-1",
              config: { channelId: "channel-1" },
              credential_id: "credential-1",
            },
          ];
        }
        if (query.includes("FROM credentials")) {
          return [{ value: "encrypted-token" }];
        }
        if (query.includes("UPDATE voice_sessions")) {
          if (claimed) {
            updateResults.push(0);
            return [];
          }
          claimed = true;
          updateResults.push(1);
          return [{ id: "session-1" }];
        }
        throw new Error(`unexpected SQL in test: ${query}`);
      },
    );

    mocks.select.mockImplementation((fields: Record<string, unknown>) => {
      if ("startedAt" in fields) {
        return mockSelectRows([
          {
            id: "session-1",
            startedAt: new Date("2026-04-23T16:12:00Z"),
            endedAt: new Date("2026-04-23T16:15:00Z"),
          },
        ]);
      }

      return mockSelectRows([
        { kind: "user_phrase", text: "summarize the call" },
        { kind: "ea_phrase", text: "summary posted" },
      ]);
    });

    await Promise.all([
      postCallSummary("hive-1", "session-1"),
      postCallSummary("hive-1", "session-1"),
    ]);

    expect(updateResults).toEqual([1, 0]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/channel-1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bot discord-bot",
        }),
      }),
    );
  });
});
