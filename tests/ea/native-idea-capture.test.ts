import { describe, it, expect, beforeEach, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import {
  buildIdeaCaptureConfirmation,
  captureEaIdea,
  handleIdeaCaptureMessage,
  parseIdeaCapture,
} from "@/ea/native/idea-capture";
import { getThreadMessages, getOrCreateActiveThread } from "@/ea/native/thread-store";

const HIVE = "55555555-5555-5555-5555-555555555555";
const API_BASE = "http://localhost:3002";

async function callIdeasApiMock(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.toString()
      : input.url;
  const match = new URL(url).pathname.match(/^\/api\/hives\/([^/]+)\/ideas$/);
  if (!match) {
    throw new Error(`unexpected fetch in native-idea-capture test: ${url}`);
  }
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  const rawBody = input instanceof Request ? await input.text() : init?.body;
  const body =
    typeof rawBody === "string" && rawBody.length > 0
      ? JSON.parse(rawBody) as { title?: unknown; body?: unknown }
      : {};

  if (headers.get("x-system-role") !== "ea") {
    return Response.json({ error: "missing ea attribution header" }, { status: 400 });
  }
  if (!headers.get("authorization")?.startsWith("Bearer ")) {
    return Response.json({ error: "missing bearer token" }, { status: 401 });
  }
  if (typeof body.title !== "string" || body.title.trim() === "") {
    return Response.json({ error: "title is required" }, { status: 400 });
  }

  const [hive] = await sql<{ id: string }[]>`SELECT id FROM hives WHERE id = ${match[1]}`;
  if (!hive) {
    return Response.json({ error: "hive not found" }, { status: 404 });
  }

  const [row] = await sql<{
    id: string;
    title: string;
    body: string | null;
    created_by: string;
    status: string;
  }[]>`
    INSERT INTO hive_ideas (hive_id, title, body, created_by)
    VALUES (${match[1]}, ${body.title.trim()}, ${typeof body.body === "string" ? body.body : null}, 'ea')
    RETURNING id, title, body, created_by, status
  `;
  return Response.json({
    data: {
      id: row.id,
      title: row.title,
      body: row.body,
      createdBy: row.created_by,
      status: row.status,
    },
  }, { status: 201 });
}

beforeEach(async () => {
  await truncateAll(sql);
  process.env.INTERNAL_SERVICE_TOKEN = "test-internal-service-token";
  await sql`
    INSERT INTO hives (id, slug, name, type, description)
    VALUES (${HIVE}, 'ic', 'Idea Capture Biz', 'digital', 'fixture hive')
  `;
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", vi.fn(callIdeasApiMock));
});

describe("parseIdeaCapture — prefix detection", () => {
  it("recognises 'idea:' at message start", () => {
    const out = parseIdeaCapture("idea: revisit annual pricing");
    expect(out).not.toBeNull();
    expect(out!.prefix).toBe("idea:");
    expect(out!.title).toBe("revisit annual pricing");
    expect(out!.body).toBeNull();
  });

  it("recognises 'add idea:' at message start", () => {
    const out = parseIdeaCapture("add idea: weekly digest email");
    expect(out).not.toBeNull();
    expect(out!.prefix).toBe("add idea:");
    expect(out!.title).toBe("weekly digest email");
  });

  it("recognises 'park this:' at message start", () => {
    const out = parseIdeaCapture("park this: spike a referral program");
    expect(out).not.toBeNull();
    expect(out!.prefix).toBe("park this:");
    expect(out!.title).toBe("spike a referral program");
  });

  it("matches case-insensitively for every prefix", () => {
    expect(parseIdeaCapture("IDEA: caps test")?.title).toBe("caps test");
    expect(parseIdeaCapture("Idea: title-cased")?.title).toBe("title-cased");
    expect(parseIdeaCapture("Add Idea: mixed case")?.title).toBe("mixed case");
    expect(parseIdeaCapture("PARK THIS: shouted")?.title).toBe("shouted");
  });

  it("tolerates leading whitespace before the prefix", () => {
    const out = parseIdeaCapture("   idea: leading space");
    expect(out).not.toBeNull();
    expect(out!.title).toBe("leading space");
  });

  it("does NOT match prefixes that appear mid-message", () => {
    expect(parseIdeaCapture("here is an idea: not at start")).toBeNull();
    expect(parseIdeaCapture("question — add idea: midway")).toBeNull();
  });

  it("does NOT match similar-looking words that aren't the exact prefix", () => {
    expect(parseIdeaCapture("ideas: plural form")).toBeNull();
    expect(parseIdeaCapture("ideal: typo")).toBeNull();
    expect(parseIdeaCapture("ideabank: branded")).toBeNull();
  });

  it("returns null when the prefix has no body after it", () => {
    expect(parseIdeaCapture("idea:")).toBeNull();
    expect(parseIdeaCapture("idea:    ")).toBeNull();
    expect(parseIdeaCapture("add idea:\n\n")).toBeNull();
  });

  it("non-prefixed messages return null (so the EA reasoning flow runs)", () => {
    expect(parseIdeaCapture("hey, what's the status of goal X?")).toBeNull();
    expect(parseIdeaCapture("create a task to fix the deploy")).toBeNull();
    expect(parseIdeaCapture("")).toBeNull();
  });

  it("splits multi-line input into title (first line) + body (rest)", () => {
    const out = parseIdeaCapture(
      "idea: bundle monthly digest\nA short paragraph about why\nand a follow-up sentence.",
    );
    expect(out).not.toBeNull();
    expect(out!.title).toBe("bundle monthly digest");
    expect(out!.body).toBe(
      "A short paragraph about why\nand a follow-up sentence.",
    );
  });

  it("promotes the first non-empty line to the title when the prefix is followed by a newline", () => {
    const out = parseIdeaCapture("park this:\n\ntry a B2B onboarding flow\nwith a video walkthrough");
    expect(out).not.toBeNull();
    expect(out!.title).toBe("try a B2B onboarding flow");
    expect(out!.body).toBe("with a video walkthrough");
  });

  it("matches the longer 'add idea:' prefix without bleeding into 'idea:'", () => {
    // Regression guard: a naive longest-match-loses ordering would chop the
    // leading 'a' and produce title="dea: foo".
    const out = parseIdeaCapture("add idea: foo");
    expect(out!.prefix).toBe("add idea:");
    expect(out!.title).toBe("foo");
  });

  it("caps the title at 255 chars and overflows the rest into the body", () => {
    const longTitle = "x".repeat(300);
    const out = parseIdeaCapture(`idea: ${longTitle}`);
    expect(out!.title.length).toBe(255);
    expect(out!.body).not.toBeNull();
    expect(out!.body!.length).toBeGreaterThanOrEqual(45);
  });
});

describe("captureEaIdea — DB persistence", () => {
  it("inserts a row with created_by='ea' and status='open'", async () => {
    const captured = await captureEaIdea(sql, HIVE, API_BASE, {
      prefix: "idea:",
      title: "Bundle monthly digest",
      body: null,
    });
    expect(captured.id).toMatch(/^[0-9a-f-]{36}$/);

    const [row] = await sql<
      {
        title: string;
        body: string | null;
        created_by: string;
        status: string;
        ai_assessment: string | null;
        promoted_to_goal_id: string | null;
      }[]
    >`SELECT title, body, created_by, status, ai_assessment, promoted_to_goal_id
      FROM hive_ideas WHERE id = ${captured.id}`;
    expect(row.title).toBe("Bundle monthly digest");
    expect(row.body).toBeNull();
    expect(row.created_by).toBe("ea");
    expect(row.status).toBe("open");
    expect(row.ai_assessment).toBeNull();
    expect(row.promoted_to_goal_id).toBeNull();
  });

  it("calls the ideas API with EA role attribution headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await captureEaIdea(sql, HIVE, API_BASE, {
      prefix: "idea:",
      title: "Bundle monthly digest",
      body: null,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [target, init] = fetchSpy.mock.calls[0]!;
    expect(String(target)).toBe(`${API_BASE}/api/hives/${HIVE}/ideas`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["X-System-Role"]).toBe("ea");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer test-internal-service-token",
    );
  });

  it("persists the body when present", async () => {
    const captured = await captureEaIdea(sql, HIVE, API_BASE, {
      prefix: "park this:",
      title: "Spike a referral program",
      body: "Look at how Notion handled their friend-of-a-friend invites.",
    });
    const [row] = await sql<{ body: string | null }[]>`
      SELECT body FROM hive_ideas WHERE id = ${captured.id}
    `;
    expect(row.body).toBe("Look at how Notion handled their friend-of-a-friend invites.");
  });
});

describe("buildIdeaCaptureConfirmation", () => {
  it("returns the one-line confirmation that contains the idea id", () => {
    const id = "abc12345-0000-0000-0000-000000000000";
    const reply = buildIdeaCaptureConfirmation(id);
    expect(reply).toContain(id);
    expect(reply).toBe("Parked as idea abc12345-0000-0000-0000-000000000000 — will surface in tomorrow's review.");
    // One line — no embedded newlines so it lands as a single Discord reply.
    expect(reply).not.toContain("\n");
  });
});

describe("handleIdeaCaptureMessage — end-to-end DM flow", () => {
  it("returns null for non-prefixed messages so the EA reasoning flow runs", async () => {
    // No spies needed — by returning null we hand control back to the
    // caller, which routes to the existing runEa() path. The contract is
    // 'null = not a capture, fall through' and we assert that here.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const out = await handleIdeaCaptureMessage(
      sql,
      HIVE,
      API_BASE,
      "chan-1",
      "hey, status update on the deploy?",
    );
    expect(out).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    const rows = await sql`SELECT id FROM hive_ideas WHERE hive_id = ${HIVE}`;
    expect(rows.length).toBe(0);
  });

  it("captures, persists, and returns the confirmation reply", async () => {
    const out = await handleIdeaCaptureMessage(
      sql,
      HIVE,
      API_BASE,
      "chan-2",
      "idea: send weekly recap to the owner",
      "discord-msg-1",
    );
    expect(out).not.toBeNull();
    expect(out!.ideaId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out!.reply).toContain(out!.ideaId);
    expect(out!.reply).toContain("Parked as idea");
    expect(out!.reply).toContain("tomorrow's review");

    const [row] = await sql<{ title: string; created_by: string; status: string }[]>`
      SELECT title, created_by, status FROM hive_ideas WHERE id = ${out!.ideaId}
    `;
    expect(row.title).toBe("send weekly recap to the owner");
    expect(row.created_by).toBe("ea");
    expect(row.status).toBe("open");
  });

  it("logs both the owner message and the assistant confirmation on the active thread", async () => {
    const out = await handleIdeaCaptureMessage(
      sql,
      HIVE,
      API_BASE,
      "chan-3",
      "park this: experiment with annual billing discount",
      "discord-msg-2",
    );
    expect(out).not.toBeNull();

    const thread = await getOrCreateActiveThread(sql, HIVE, "chan-3");
    const msgs = await getThreadMessages(sql, thread.id, 10);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("owner");
    expect(msgs[0].content).toBe("park this: experiment with annual billing discount");
    expect(msgs[0].discordMessageId).toBe("discord-msg-2");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe(out!.reply);
  });

  it("does NOT load the EA prompt or invoke the runner — capture is plain persistence", async () => {
    // The capture path lives in src/ea/native/idea-capture.ts and
    // intentionally does not import buildEaPrompt or runEa. This test
    // belt-and-braces that contract by spying on both modules and
    // asserting they're never touched during a capture.
    const promptModule = await import("@/ea/native/prompt");
    const runnerModule = await import("@/ea/native/runner");
    const promptSpy = vi.spyOn(promptModule, "buildEaPrompt");
    const runnerSpy = vi.spyOn(runnerModule, "runEa");

    try {
      const out = await handleIdeaCaptureMessage(
        sql,
        HIVE,
        API_BASE,
        "chan-4",
        "add idea: ship a weekly automated report",
      );
      expect(out).not.toBeNull();
      expect(promptSpy).not.toHaveBeenCalled();
      expect(runnerSpy).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
      runnerSpy.mockRestore();
    }
  });

  it("each of the three documented prefixes routes to plain persistence (case-insensitive)", async () => {
    const samples: { content: string; expectedTitle: string }[] = [
      { content: "Idea: refresh the onboarding emails", expectedTitle: "refresh the onboarding emails" },
      { content: "ADD IDEA: monthly retro doc", expectedTitle: "monthly retro doc" },
      { content: "Park this: try a partner channel", expectedTitle: "try a partner channel" },
    ];

    for (const [i, sample] of samples.entries()) {
      const out = await handleIdeaCaptureMessage(
        sql,
        HIVE,
        API_BASE,
        `chan-prefix-${i}`,
        sample.content,
      );
      expect(out).not.toBeNull();
      const [row] = await sql<{ title: string; created_by: string }[]>`
        SELECT title, created_by FROM hive_ideas WHERE id = ${out!.ideaId}
      `;
      expect(row.title).toBe(sample.expectedTitle);
      expect(row.created_by).toBe("ea");
    }
  });
});
