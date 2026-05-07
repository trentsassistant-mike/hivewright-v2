import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import {
  appendMessage,
  closeActiveThread,
  getOrCreateActiveThread,
  getThreadMessages,
  loadThreadReplayMessageLimit,
} from "@/ea/native/thread-store";
import {
  DEFAULT_EA_REPLAY_MESSAGE_LIMIT,
  EA_REPLAY_ADAPTER_TYPE,
  EA_REPLAY_MESSAGE_LIMIT_KEY,
} from "@/ea/replay-settings";

const BIZ = "33333333-3333-3333-3333-333333333333";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${BIZ}, 'tsb', 'Thread Store Biz', 'digital')
  `;
});

describe("getOrCreateActiveThread", () => {
  it("creates a new active thread the first time", async () => {
    const t = await getOrCreateActiveThread(sql, BIZ, "chan-1");
    expect(t.status).toBe("active");
    expect(t.hiveId).toBe(BIZ);
    expect(t.channelId).toBe("chan-1");
  });

  it("returns the same active thread on subsequent calls", async () => {
    const a = await getOrCreateActiveThread(sql, BIZ, "chan-2");
    const b = await getOrCreateActiveThread(sql, BIZ, "chan-2");
    expect(a.id).toBe(b.id);
  });

  it("returns different active threads for different channels", async () => {
    const a = await getOrCreateActiveThread(sql, BIZ, "chan-a");
    const b = await getOrCreateActiveThread(sql, BIZ, "chan-b");
    expect(a.id).not.toBe(b.id);
  });
});

describe("closeActiveThread", () => {
  it("closes the active thread and lets a fresh one be created next time", async () => {
    const first = await getOrCreateActiveThread(sql, BIZ, "chan-close");
    await closeActiveThread(sql, BIZ, "chan-close");
    const second = await getOrCreateActiveThread(sql, BIZ, "chan-close");
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("active");

    const [closedRow] = await sql<{ status: string; closed_at: Date | null }[]>`
      SELECT status, closed_at FROM ea_threads WHERE id = ${first.id}
    `;
    expect(closedRow.status).toBe("closed");
    expect(closedRow.closed_at).not.toBeNull();
  });

  it("is idempotent if no active thread exists", async () => {
    await expect(closeActiveThread(sql, BIZ, "chan-noop")).resolves.toBeUndefined();
  });
});

describe("appendMessage + getThreadMessages", () => {
  it("stores messages and returns them oldest-first up to the limit", async () => {
    const t = await getOrCreateActiveThread(sql, BIZ, "chan-msg");
    await appendMessage(sql, t.id, "owner", "first");
    await appendMessage(sql, t.id, "assistant", "reply-1");
    await appendMessage(sql, t.id, "owner", "second");

    const msgs = await getThreadMessages(sql, t.id, 10);
    expect(msgs.map((m) => m.content)).toEqual(["first", "reply-1", "second"]);
    expect(msgs.map((m) => m.role)).toEqual(["owner", "assistant", "owner"]);
  });

  it("caps results at the limit, keeping the most recent window", async () => {
    const t = await getOrCreateActiveThread(sql, BIZ, "chan-cap");
    for (let i = 0; i < 5; i++) {
      await appendMessage(sql, t.id, "owner", `msg-${i}`);
    }
    const msgs = await getThreadMessages(sql, t.id, 3);
    expect(msgs.map((m) => m.content)).toEqual(["msg-2", "msg-3", "msg-4"]);
  });

  it("defaults the replay window to 80 messages when unset", async () => {
    const t = await getOrCreateActiveThread(sql, BIZ, "chan-default-replay");
    for (let i = 0; i < 85; i++) {
      const msg = await appendMessage(sql, t.id, "owner", `msg-${i}`);
      await sql`
        UPDATE ea_messages
        SET created_at = ${new Date(Date.UTC(2026, 0, 1, 0, 0, i))}
        WHERE id = ${msg.id}
      `;
    }

    await expect(loadThreadReplayMessageLimit(sql)).resolves.toBe(
      DEFAULT_EA_REPLAY_MESSAGE_LIMIT,
    );
    const msgs = await getThreadMessages(sql, t.id);

    expect(msgs).toHaveLength(DEFAULT_EA_REPLAY_MESSAGE_LIMIT);
    expect(msgs[0].content).toBe("msg-5");
    expect(msgs.at(-1)?.content).toBe("msg-84");
  });

  it("honors the configured replay window from global adapter_config", async () => {
    const t = await getOrCreateActiveThread(sql, BIZ, "chan-configured-replay");
    for (let i = 0; i < 20; i++) {
      const msg = await appendMessage(sql, t.id, "owner", `msg-${i}`);
      await sql`
        UPDATE ea_messages
        SET created_at = ${new Date(Date.UTC(2026, 0, 1, 0, 0, i))}
        WHERE id = ${msg.id}
      `;
    }

    await sql`
      INSERT INTO adapter_config (adapter_type, config)
      VALUES (
        ${EA_REPLAY_ADAPTER_TYPE},
        ${sql.json({ [EA_REPLAY_MESSAGE_LIMIT_KEY]: 12 })}
      )
    `;

    await expect(loadThreadReplayMessageLimit(sql)).resolves.toBe(12);
    const msgs = await getThreadMessages(sql, t.id);

    expect(msgs).toHaveLength(12);
    expect(msgs[0].content).toBe("msg-8");
    expect(msgs.at(-1)?.content).toBe("msg-19");
  });

  it("rejects non-enum role values (CHECK constraint)", async () => {
    const t = await getOrCreateActiveThread(sql, BIZ, "chan-role");
    // @ts-expect-error intentionally invalid to exercise the CHECK constraint
    await expect(appendMessage(sql, t.id, "robot", "nope")).rejects.toThrow();
  });
});
