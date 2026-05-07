import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import { NextResponse } from "next/server";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { EA_MAX_ATTACHMENT_BYTES } from "@/ea/native/attachments";

vi.mock("@/app/api/_lib/auth", () => ({
  requireApiUser: vi.fn(),
}));

vi.mock("@/auth/users", () => ({
  canAccessHive: vi.fn(),
}));

vi.mock("@/ea/native/runner", () => ({
  runEa: vi.fn(),
  runEaStream: vi.fn(async function* () {
    yield "Here is ";
    yield "the hive status.";
  }),
}));

import { DELETE, GET, POST } from "@/app/api/ea/chat/route";
import { requireApiUser } from "@/app/api/_lib/auth";
import { canAccessHive } from "@/auth/users";
import { runEa, runEaStream } from "@/ea/native/runner";

const mockRequireApiUser = vi.mocked(requireApiUser);
const mockCanAccessHive = vi.mocked(canAccessHive);
const mockRunEa = vi.mocked(runEa);
const mockRunEaStream = vi.mocked(runEaStream);

const HIVE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HIVE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";

async function callGet(request: Request): Promise<Response> {
  return (await GET(request)) as unknown as Response;
}

async function callPost(request: Request): Promise<Response> {
  return (await POST(request)) as unknown as Response;
}

async function callDelete(request: Request): Promise<Response> {
  return (await DELETE(request)) as unknown as Response;
}

function jsonRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/ea/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function multipartRequest(input: { hiveId: string; content: string; files: File[] }) {
  const body = new FormData();
  body.append("hiveId", input.hiveId);
  body.append("content", input.content);
  for (const file of input.files) body.append("files", file);
  return new Request("http://localhost/api/ea/chat", {
    method: "POST",
    headers: { "Accept": "text/event-stream" },
    body,
  });
}

async function seedHives() {
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES
      (${HIVE_A}, 'ea-chat-a', 'EA Chat Hive A', 'digital'),
      (${HIVE_B}, 'ea-chat-b', 'EA Chat Hive B', 'digital')
  `;
}

async function readDashboardMessages(hiveId: string) {
  return sql<
    {
      role: string;
      content: string;
      source: string;
      status: string;
      error: string | null;
    }[]
  >`
    SELECT m.role, m.content, m.source, m.status, m.error
    FROM ea_messages m
    JOIN ea_threads t ON t.id = m.thread_id
    WHERE t.hive_id = ${hiveId}
      AND t.channel_id = ${`dashboard:${hiveId}`}
    ORDER BY m.created_at ASC
  `;
}

describe("/api/ea/chat", () => {
  beforeEach(async () => {
    await truncateAll(sql);
    await seedHives();
    vi.clearAllMocks();
    mockRequireApiUser.mockResolvedValue({
      user: { id: OWNER_ID, email: "owner@local", isSystemOwner: true },
    });
    mockCanAccessHive.mockResolvedValue(true);
  });

  it("GET creates/returns the active dashboard thread with empty messages", async () => {
    const res = await callGet(
      new Request(`http://localhost/api/ea/chat?hiveId=${HIVE_A}`),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.thread.hiveId).toBe(HIVE_A);
    expect(body.data.thread.channelId).toBe(`dashboard:${HIVE_A}`);
    expect(body.data.messages).toEqual([]);
  });

  it("POST persists the owner message and assistant response through existing EA tables", async () => {
    const res = await callPost(
      jsonRequest({ hiveId: HIVE_A, content: "What needs my attention?" }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.assistantMessage.status).toBe("sent");
    expect(body.data.ownerMessage.source).toBe("dashboard");
    expect(body.data.assistantMessage.content).toBe("Here is the hive status.");
    expect(mockRunEaStream).toHaveBeenCalledTimes(1);
    expect(mockRunEa).not.toHaveBeenCalled();
    const prompt = mockRunEaStream.mock.calls[0]?.[0] as string;
    expect(prompt).toContain(`X-HiveWright-EA-Source-Hive-Id: ${HIVE_A}`);
    expect(prompt).toContain(`X-HiveWright-EA-Thread-Id: ${body.data.thread.id}`);
    expect(prompt).toContain(`X-HiveWright-EA-Owner-Message-Id: ${body.data.ownerMessage.id}`);
    expect(prompt).toContain("X-HiveWright-EA-Source: dashboard");

    const messages = await readDashboardMessages(HIVE_A);
    expect(messages).toEqual([
      {
        role: "owner",
        content: "What needs my attention?",
        source: "dashboard",
        status: "sent",
        error: null,
      },
      {
        role: "assistant",
        content: "Here is the hive status.",
        source: "dashboard",
        status: "sent",
        error: null,
      },
    ]);
  });

  it("POST accepts multipart attachments, stages them, and passes paths to the EA stream", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "screen shot.png", {
      type: "image/png",
    });

    const res = await callPost(
      multipartRequest({ hiveId: HIVE_A, content: "What is in this image?", files: [file] }),
    );

    expect(res.status).toBe(201);
    const runCalls = mockRunEaStream.mock.calls as Array<
      [string, { signal?: AbortSignal; attachmentPaths?: string[] } | undefined]
    >;
    const options = runCalls[0]?.[1];
    expect(options?.attachmentPaths).toHaveLength(1);
    const stagedPath = options?.attachmentPaths?.[0] ?? "";
    expect(stagedPath).toMatch(/^\/tmp\/hivewright-ea-attachments\/dashboard-/);
    expect(stagedPath.endsWith("/screen_shot.png")).toBe(true);
    expect(fs.existsSync(stagedPath)).toBe(true);
    expect(runCalls[0]?.[0]).toContain(`@${stagedPath}`);

    const messages = await readDashboardMessages(HIVE_A);
    expect(messages[0]?.content).toContain("@/tmp/hivewright-ea-attachments/");
  });

  it("POST rejects oversized multipart attachments with a clear error", async () => {
    const oversized = new File([new Uint8Array(EA_MAX_ATTACHMENT_BYTES + 1)], "huge.pdf", {
      type: "application/pdf",
    });

    const res = await callPost(
      multipartRequest({ hiveId: HIVE_A, content: "Review this", files: [oversized] }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('File "huge.pdf" exceeds the 25 MB size limit.');
    expect(mockRunEaStream).not.toHaveBeenCalled();
    expect(mockRunEa).not.toHaveBeenCalled();
    expect(await readDashboardMessages(HIVE_A)).toEqual([]);
  });

  it("returns 401 before touching chat state when unauthenticated", async () => {
    mockRequireApiUser.mockResolvedValue({
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const res = await callPost(
      jsonRequest({ hiveId: HIVE_A, content: "hello" }),
    );

    expect(res.status).toBe(401);
    expect(mockRunEaStream).not.toHaveBeenCalled();
    expect(mockRunEa).not.toHaveBeenCalled();
    expect(await readDashboardMessages(HIVE_A)).toEqual([]);
  });

  it("denies cross-hive access for non-members before creating threads", async () => {
    mockRequireApiUser.mockResolvedValue({
      user: { id: MEMBER_ID, email: "member@local", isSystemOwner: false },
    });
    mockCanAccessHive.mockResolvedValue(false);

    const res = await callPost(
      jsonRequest({ hiveId: HIVE_B, content: "show me that hive" }),
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden: caller cannot access this hive");
    expect(mockRunEaStream).not.toHaveBeenCalled();
    expect(mockRunEa).not.toHaveBeenCalled();
    expect(await readDashboardMessages(HIVE_B)).toEqual([]);
  });

  it("GET also denies cross-hive reads for non-members", async () => {
    mockRequireApiUser.mockResolvedValue({
      user: { id: MEMBER_ID, email: "member@local", isSystemOwner: false },
    });
    mockCanAccessHive.mockResolvedValue(false);

    const res = await callGet(
      new Request(`http://localhost/api/ea/chat?hiveId=${HIVE_B}`),
    );

    expect(res.status).toBe(403);
    expect(await readDashboardMessages(HIVE_B)).toEqual([]);
  });

  it("DELETE returns 401 before closing chat state when unauthenticated", async () => {
    await callGet(new Request(`http://localhost/api/ea/chat?hiveId=${HIVE_A}`));
    mockRequireApiUser.mockResolvedValue({
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    });

    const res = await callDelete(
      new Request(`http://localhost/api/ea/chat?hiveId=${HIVE_A}`, {
        method: "DELETE",
      }),
    );

    expect(res.status).toBe(401);
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM ea_threads WHERE hive_id = ${HIVE_A}
    `;
    expect(rows).toEqual([{ status: "active" }]);
  });

  it("DELETE denies cross-hive close attempts for non-members", async () => {
    await callGet(new Request(`http://localhost/api/ea/chat?hiveId=${HIVE_B}`));
    mockRequireApiUser.mockResolvedValue({
      user: { id: MEMBER_ID, email: "member@local", isSystemOwner: false },
    });
    mockCanAccessHive.mockResolvedValue(false);

    const res = await callDelete(
      new Request(`http://localhost/api/ea/chat?hiveId=${HIVE_B}`, {
        method: "DELETE",
      }),
    );

    expect(res.status).toBe(403);
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM ea_threads
      WHERE hive_id = ${HIVE_B} AND channel_id = ${`dashboard:${HIVE_B}`}
    `;
    expect(rows).toEqual([{ status: "active" }]);
  });

  it("persists partial assistant content when the EA stream fails", async () => {
    mockRunEaStream.mockImplementationOnce(async function* () {
      yield "partial";
      throw new Error("provider unavailable");
    });

    const res = await callPost(
      jsonRequest({ hiveId: HIVE_A, content: "status please" }),
    );

    expect(res.status).toBe(500);
    expect(mockRunEa).not.toHaveBeenCalled();

    const messages = await readDashboardMessages(HIVE_A);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "partial",
      source: "dashboard",
      status: "sent",
    });
  });

  it("does not write raw owner chat content to console logs on EA stream failure", async () => {
    const sensitiveOwnerText = "status please password: do-not-log-this";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRunEaStream.mockImplementationOnce(async function* () {
      throw new Error("provider error should stay internal");
    });

    const res = await callPost(
      jsonRequest({ hiveId: HIVE_A, content: sensitiveOwnerText }),
    );

    expect(res.status).toBe(500);
    const renderedLogs = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .flat()
      .map((part) => String(part))
      .join("\n");
    expect(renderedLogs).not.toContain(sensitiveOwnerText);
    expect(renderedLogs).not.toContain("do-not-log-this");
    expect(mockRunEa).not.toHaveBeenCalled();
  });

  it("returns 409 while an assistant turn is already streaming", async () => {
    const getRes = await callGet(
      new Request(`http://localhost/api/ea/chat?hiveId=${HIVE_A}`),
    );
    const threadId = (await getRes.json()).data.thread.id;
    const [assistant] = await sql<{ id: string }[]>`
      INSERT INTO ea_messages (thread_id, role, content, source, status)
      VALUES (${threadId}, 'assistant', '', 'dashboard', 'streaming')
      RETURNING id
    `;

    const res = await callPost(
      jsonRequest({ hiveId: HIVE_A, content: "second message" }),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("EA is already responding");
    expect(mockRunEaStream).not.toHaveBeenCalled();
    expect(mockRunEa).not.toHaveBeenCalled();
    expect(assistant.id).toBeTruthy();
  });

  it("DELETE closes only the caller's dashboard thread for the requested hive", async () => {
    await callGet(new Request(`http://localhost/api/ea/chat?hiveId=${HIVE_A}`));
    await callGet(new Request(`http://localhost/api/ea/chat?hiveId=${HIVE_B}`));

    const res = await callDelete(
      new Request(`http://localhost/api/ea/chat?hiveId=${HIVE_A}`, {
        method: "DELETE",
      }),
    );

    expect(res.status).toBe(200);
    const rows = await sql<{ hive_id: string; status: string }[]>`
      SELECT hive_id, status
      FROM ea_threads
      WHERE channel_id IN (${`dashboard:${HIVE_A}`}, ${`dashboard:${HIVE_B}`})
      ORDER BY hive_id
    `;
    expect(rows.filter((row) => row.hive_id === HIVE_A)).toEqual(
      expect.arrayContaining([
        { hive_id: HIVE_A, status: "closed" },
        { hive_id: HIVE_A, status: "active" },
      ]),
    );
    expect(rows.filter((row) => row.hive_id === HIVE_B)).toEqual([
      { hive_id: HIVE_B, status: "active" },
    ]);
  });
});
