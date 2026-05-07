import { beforeEach, describe, expect, it, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

vi.mock("@/app/api/_lib/db", () => ({ sql }));

const mocks = vi.hoisted(() => ({
  state: { streamReturned: false },
  buildEaPrompt: vi.fn(async () => "FULL EA PROMPT"),
  runEaStream: vi.fn(),
  scheduleImplicitQualityExtraction: vi.fn(),
}));

mocks.runEaStream.mockImplementation(
  async function* (prompt: string, options?: { signal?: AbortSignal }) {
    void prompt;
    void options;
    try {
      yield "Hello";
      yield ", dashboard.";
    } finally {
      mocks.state.streamReturned = true;
    }
  },
);

vi.mock("@/ea/native/prompt", () => ({
  buildEaPrompt: mocks.buildEaPrompt,
}));

vi.mock("@/ea/native/runner", () => ({
  runEaStream: mocks.runEaStream,
  runEa: vi.fn(),
}));

vi.mock("@/quality/ea-post-turn", () => ({
  scheduleImplicitQualityExtraction: mocks.scheduleImplicitQualityExtraction,
}));

import { dashboardEaClient } from "@/ea/native/dashboard-chat";
import type { EaMessage } from "@/ea/native/thread-store";

const HIVE_ID = "99999999-9999-4999-8999-999999999999";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'dashboard-chat-native', 'Dashboard Native Hive', 'digital')
  `;
  vi.clearAllMocks();
  mocks.state.streamReturned = false;
});

describe("dashboardEaClient.submit", () => {
  it("builds the full EA prompt, uses the dashboard hive thread, and persists both turns", async () => {
    const stream = await dashboardEaClient.submit("What active goals do I have?", {
      hiveId: HIVE_ID,
      hiveName: "Dashboard Native Hive",
    });

    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks).toEqual(["Hello", ", dashboard."]);
    expect(mocks.buildEaPrompt).toHaveBeenCalledTimes(1);
    const buildPromptCalls = mocks.buildEaPrompt.mock.calls as unknown as Array<
      [
        unknown,
        {
          hiveId: string;
          hiveName: string;
          currentOwnerMessage: string;
          history: EaMessage[];
        },
      ]
    >;
    const promptInput = buildPromptCalls[0]?.[1];
    expect(promptInput).toMatchObject({
      hiveId: HIVE_ID,
      hiveName: "Dashboard Native Hive",
      currentOwnerMessage: "What active goals do I have?",
    });
    expect(promptInput?.history.at(-1)).toMatchObject({
      role: "owner",
      content: "What active goals do I have?",
      source: "dashboard",
    });
    const firstRunCalls = mocks.runEaStream.mock.calls as Array<
      [string, { signal?: AbortSignal; attachmentPaths?: string[] } | undefined]
    >;
    const firstRunOptions = firstRunCalls[0]?.[1];
    expect(mocks.runEaStream).toHaveBeenCalledWith("FULL EA PROMPT", {
      signal: firstRunOptions?.signal,
      attachmentPaths: [],
    });
    expect(firstRunOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(firstRunOptions?.signal?.aborted).toBe(false);

    const rows = await sql<
      {
        channel_id: string;
        role: string;
        content: string;
        source: string;
      }[]
    >`
      SELECT t.channel_id, m.role, m.content, m.source
      FROM ea_messages m
      JOIN ea_threads t ON t.id = m.thread_id
      WHERE t.hive_id = ${HIVE_ID}
      ORDER BY m.created_at ASC
    `;

    expect(rows).toEqual([
      {
        channel_id: `dashboard:${HIVE_ID}`,
        role: "owner",
        content: "What active goals do I have?",
        source: "dashboard",
      },
      {
        channel_id: `dashboard:${HIVE_ID}`,
        role: "assistant",
        content: "Hello, dashboard.",
        source: "dashboard",
      },
    ]);
    expect(mocks.scheduleImplicitQualityExtraction).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        hiveId: HIVE_ID,
        ownerMessage: "What active goals do I have?",
      }),
    );
  });

  it("passes dashboard attachment paths through to runEaStream", async () => {
    const stream = await dashboardEaClient.submit("Review this brief", {
      hiveId: HIVE_ID,
      hiveName: "Dashboard Native Hive",
      attachments: [
        {
          filename: "brief.pdf",
          absolutePath: "/tmp/hivewright-ea-attachments/dashboard-1/brief.pdf",
          contentType: "application/pdf",
          size: 2048,
        },
      ],
    });

    for await (const chunk of stream) void chunk;

    const runCalls = mocks.runEaStream.mock.calls as Array<
      [string, { signal?: AbortSignal; attachmentPaths?: string[] } | undefined]
    >;
    expect(runCalls[0]?.[0]).toContain("@/tmp/hivewright-ea-attachments/dashboard-1/brief.pdf");
    expect(runCalls[0]?.[1]?.attachmentPaths).toEqual([
      "/tmp/hivewright-ea-attachments/dashboard-1/brief.pdf",
    ]);
  });

  it("aborts the runEaStream signal when the dashboard stream consumer breaks early", async () => {
    const controller = new AbortController();
    const stream = await dashboardEaClient.submit("stop early", {
      hiveId: HIVE_ID,
      signal: controller.signal,
    });

    for await (const chunk of stream) {
      expect(chunk).toBe("Hello");
      break;
    }

    const runCalls = mocks.runEaStream.mock.calls as Array<
      [string, { signal?: AbortSignal; attachmentPaths?: string[] } | undefined]
    >;
    const runOptions = runCalls[0]?.[1];
    expect(runOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(runOptions?.signal).not.toBe(controller.signal);
    expect(runOptions?.signal?.aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(mocks.state.streamReturned).toBe(true);
  });
});
