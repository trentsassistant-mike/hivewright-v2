import { EventEmitter } from "events";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { parseCodexLine, CodexJsonChunker } from "@/adapters/codex-stream-parser";
import {
  buildCodexEmptyOutputDiagnostic,
  CodexAdapter,
  collectCodexAgentTexts,
  collectCodexFinalAgentText,
  isCodexRolloutRegistrationFailure,
} from "@/adapters/codex";
import type { SessionContext } from "@/adapters/types";
import type { ClaimedTask } from "@/dispatcher/types";

const { mockSpawn, mockRecordAgentAuditEventBestEffort } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockRecordAgentAuditEventBestEffort: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("@/audit/agent-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/audit/agent-events")>();
  return {
    ...actual,
    recordAgentAuditEventBestEffort: mockRecordAgentAuditEventBestEffort,
  };
});

beforeEach(() => {
  mockSpawn.mockReset();
  mockRecordAgentAuditEventBestEffort.mockReset();
});

describe("parseCodexLine", () => {
  it("returns text for an item.completed agent_message", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "Hello world." },
    });
    const parsed = parseCodexLine(line);
    expect(parsed.kind).toBe("text");
    if (parsed.kind === "text") expect(parsed.text).toBe("Hello world.");
  });

  it("returns result for turn.completed with usage", () => {
    const line = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 100, output_tokens: 25, cached_input_tokens: 50 },
    });
    const parsed = parseCodexLine(line);
    expect(parsed.kind).toBe("result");
    if (parsed.kind === "result") {
      expect(parsed.tokensInput).toBe(100);
      expect(parsed.cachedInputTokens).toBe(50);
      expect(parsed.cachedInputTokensKnown).toBe(true);
      expect(parsed.tokensOutput).toBe(25);
      expect(parsed.isError).toBe(false);
    }
  });

  it("returns error result for turn.failed events", () => {
    const line = JSON.stringify({
      type: "turn.failed",
      error: { message: "Rate limit exceeded" },
    });
    const parsed = parseCodexLine(line);
    expect(parsed.kind).toBe("result");
    if (parsed.kind === "result") {
      expect(parsed.isError).toBe(true);
      expect(parsed.errorMessage).toContain("Rate limit");
    }
  });

  it("ignores thread.started, turn.started, and other lifecycle events", () => {
    expect(parseCodexLine(JSON.stringify({ type: "thread.started", thread_id: "abc" })).kind).toBe("ignore");
    expect(parseCodexLine(JSON.stringify({ type: "turn.started" })).kind).toBe("ignore");
    expect(parseCodexLine(JSON.stringify({ type: "item.started", item: { type: "reasoning" } })).kind).toBe("ignore");
  });

  it("ignores non-JSON garbage on stdout", () => {
    expect(parseCodexLine("Reading prompt from stdin...").kind).toBe("ignore");
    expect(parseCodexLine("").kind).toBe("ignore");
    expect(parseCodexLine("not json {{{").kind).toBe("ignore");
  });
});

describe("CodexJsonChunker", () => {
  it("accumulates texts across multiple feeds and surfaces the final result", () => {
    const chunker = new CodexJsonChunker();
    const a = chunker.feed(JSON.stringify({ type: "thread.started", thread_id: "t-1" }) + "\n");
    expect(a.threadId).toBe("t-1");
    expect(a.texts).toEqual([]);

    const b = chunker.feed(
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Part 1." }}) + "\n" +
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Part 2." }}) + "\n",
    );
    expect(b.texts).toEqual(["Part 1.", "Part 2."]);
    expect(b.result).toBeNull();

    const c = chunker.feed(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 }}) + "\n");
    expect(c.result?.tokensInput).toBe(10);
  });

  it("handles a JSON object split across two chunks (partial line buffering)", () => {
    const chunker = new CodexJsonChunker();
    chunker.feed('{"type":"item.completed","item":{"type":"agent_messa');
    const out = chunker.feed('ge","text":"split delivery"}}\n');
    expect(out.texts).toEqual(["split delivery"]);
  });

  it("flush() drains a final unterminated line", () => {
    const chunker = new CodexJsonChunker();
    chunker.feed(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "tail" }}));
    // No trailing newline above — expect tail to come out only on flush()
    const tail = chunker.flush();
    expect(tail.texts).toEqual(["tail"]);
  });
});

describe("isCodexRolloutRegistrationFailure", () => {
  it("matches Codex thread-session expiry during rollout item registration", () => {
    expect(
      isCodexRolloutRegistrationFailure(
        "failed to record rollout items: thread 019dd0b1-0f3a-7313-b737-93d8967819fb not found",
      ),
    ).toBe(true);
  });

  it("does not match unrelated non-zero exits", () => {
    expect(isCodexRolloutRegistrationFailure("Process exited with code 1")).toBe(false);
  });
});

describe("collectCodexAgentTexts", () => {
  it("preserves long agent-message tails when rollout recording fails after stdout is captured", () => {
    const tailMarker = "CODex_LONG_OUTPUT_TAIL_20260429_7f4d61b2";
    const longBody = [
      "Root cause summary",
      "x".repeat(80_000),
      "Verification commands",
      tailMarker,
    ].join("\n");
    const rawStdout = [
      JSON.stringify({ type: "thread.started", thread_id: "019dd0b1-0f3a-7313-b737-93d8967819fb" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "intro" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: longBody } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 25 } }),
    ].join("\n");

    const collected = collectCodexAgentTexts(rawStdout);

    expect(collected).toContain("intro");
    expect(collected).toContain("Root cause summary");
    expect(collected).toContain(tailMarker);
    expect(isCodexRolloutRegistrationFailure(
      "codex_core::session: failed to record rollout items: thread 019dd0b1-0f3a-7313-b737-93d8967819fb not found",
    )).toBe(true);
  });

  it("returns only the final agent message for persisted task output", () => {
    const rawStdout = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "I’m checking the files and tools first." } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final deliverable: wrote the blog outline and verified the file." } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 25 } }),
    ].join("\n");

    expect(collectCodexFinalAgentText(rawStdout)).toBe("Final deliverable: wrote the blog outline and verified the file.");
  });
});

describe("CodexAdapter.translate + buildCommand", () => {
  function makeCtx(): SessionContext {
    return {
      task: {
        id: "t-1", hiveId: "h-1", assignedTo: "qa", createdBy: "owner",
        status: "active", priority: 5, title: "Verify thing",
        brief: "Check the dashboard renders",
        parentTaskId: null, goalId: null, sprintNumber: null,
        qaRequired: false, acceptanceCriteria: "No console errors",
        retryCount: 0, doctorAttempts: 0, failureReason: null,
        projectId: null,
      } as ClaimedTask,
      roleTemplate: {
        slug: "qa", department: "engineering",
        roleMd: "# QA\nVerify acceptance criteria.",
        soulMd: null, toolsMd: null,
      },
      memoryContext: { roleMemory: [], hiveMemory: [], insights: [], capacity: "small" },
      skills: [],
      standingInstructions: [],
      goalContext: null,
      projectWorkspace: "/tmp/test-workspace",
      gitBackedProject: true,
      hiveWorkspacePath: "/tmp/business-workspace",
      hiveSlug: "test-hive",
      model: "openai-codex/gpt-5.4",
      fallbackModel: null,
      credentials: {},
    };
  }

  it("strips the model prefix and includes -m + -C and bypass flags", () => {
    const adapter = new CodexAdapter();
    const args = adapter.buildCommand(makeCtx());
    expect(args).toContain("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain("--skip-git-repo-check");
    const mIdx = args.indexOf("-m");
    expect(mIdx).toBeGreaterThanOrEqual(0);
    expect(args[mIdx + 1]).toBe("gpt-5.4"); // prefix stripped
    const cIdx = args.indexOf("-C");
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(args[cIdx + 1]).toBe("/tmp/test-workspace");
  });

  it("uses a clean dispatcher-owned workspace for non-git business tasks", () => {
    const adapter = new CodexAdapter();
    const ctx = makeCtx();
    ctx.gitBackedProject = false;
    ctx.projectWorkspace = "/tmp/business-workspace-with-historical-agents";
    ctx.hiveWorkspacePath = "/tmp/business-workspace-with-historical-agents";

    const args = adapter.buildCommand(ctx);
    const cIdx = args.indexOf("-C");

    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(args[cIdx + 1]).toMatch(/\.hivewright\/task-workspaces\/t-1$/);
    expect(args[cIdx + 1]).not.toBe("/tmp/business-workspace-with-historical-agents");
  });

  it("injects output-discipline instructions so persisted results do not become tool chatter", () => {
    const adapter = new CodexAdapter();
    const prompt = adapter.translate(makeCtx());

    expect(prompt).toContain("## Output Discipline");
    expect(prompt).toContain("Do not narrate tool usage");
    expect(prompt).toContain("shown on the owner dashboard");
  });

  it("treats openai-codex/gpt-5.5 as an internal alias and passes gpt-5.5 through to codex", () => {
    const adapter = new CodexAdapter();
    const ctx = makeCtx();
    ctx.model = "openai-codex/gpt-5.5";
    const args = adapter.buildCommand(ctx);
    const mIdx = args.indexOf("-m");
    expect(mIdx).toBeGreaterThanOrEqual(0);
    expect(args[mIdx + 1]).toBe("gpt-5.5");
  });

  it("returns the codex thread id from a fresh execution", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from([
          JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }),
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 }, model: "gpt-5.5" }),
        ].join("\n")));
        proc.emit("close", 0);
      });
      return proc;
    });

    const result = await new CodexAdapter().execute(makeCtx());

    expect(result.sessionId).toBe("thread-1");
  });

  it("uses codex exec resume when sending a rework message to an existing thread", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from([
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "fixed" } }),
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 }, model: "gpt-5.5" }),
        ].join("\n")));
        proc.emit("close", 0);
      });
      return proc;
    });

    const result = await new CodexAdapter().sendMessage!(
      "thread-1",
      "Please fix the QA feedback.",
      makeCtx(),
    );

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("resume");
    expect(args).toContain("thread-1");
    expect(args).not.toContain("-C");
    expect(result.output).toBe("fixed");
  });

  it("translate emits the standard 5-layer prompt sections in order", () => {
    const adapter = new CodexAdapter();
    const prompt = adapter.translate(makeCtx());
    expect(prompt.indexOf("# QA")).toBeLessThan(prompt.indexOf("# Task: Verify thing"));
    expect(prompt).toContain("Working Directory");
    expect(prompt).toContain("Acceptance Criteria");
  });

  it("appends per-role MCP -c overrides when toolsConfig.mcps is set", () => {
    const adapter = new CodexAdapter();
    const ctx = makeCtx();
    ctx.toolsConfig = { mcps: ["context7", "playwright"] };
    const args = adapter.buildCommand(ctx);
    expect(args.some((a) => a.startsWith('mcp_servers.context7.command='))).toBe(true);
    expect(args.some((a) => a.startsWith('mcp_servers.playwright.command='))).toBe(true);
    expect(args.some((a) => a.startsWith('mcp_servers.github.command='))).toBe(false);
  });

  it("does not inject any MCP overrides when toolsConfig is null (backwards compat)", () => {
    const adapter = new CodexAdapter();
    const ctx = makeCtx();
    ctx.toolsConfig = null;
    const args = adapter.buildCommand(ctx);
    expect(args.some((a) => a.startsWith('mcp_servers.'))).toBe(false);
  });

  it("salvages captured stdout when Codex exits non-zero after rollout registration fails", async () => {
    const adapter = new CodexAdapter({ json: vi.fn((value) => value) } as never);
    const tailMarker = "CODEX_EXEC_SALVAGE_TAIL_20260501";
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "019dd0b1-0f3a-7313-b737-93d8967819fb" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Mapped repo files." } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `Verification complete.\n${tailMarker}` } }),
    ].join("\n");
    const stderr =
      "codex_core::session: failed to record rollout items: thread 019dd0b1-0f3a-7313-b737-93d8967819fb not found";
    const chunks: Array<{ text: string; type: string }> = [];

    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from(stdout));
        proc.stderr.emit("data", Buffer.from(stderr));
        proc.emit("close", 1);
      });
      return proc;
    });

    const result = await adapter.execute(makeCtx(), async (chunk) => {
      chunks.push(chunk);
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Mapped repo files.");
    expect(result.output).toContain(tailMarker);
    expect(result.failureReason).toContain("salvaged output");
    expect(result.runtimeWarnings).toEqual([
      "Codex rollout registration failed after agent output was captured; HiveWright persisted stdout directly and QA should verify the recorded tail.",
    ]);
    expect(result.runtimeDiagnostics?.codexEmptyOutput).toBeUndefined();
    expect(chunks.some((chunk) => chunk.type === "stderr" && chunk.text.includes("thread 019dd0b1"))).toBe(true);
    expect(mockRecordAgentAuditEventBestEffort).not.toHaveBeenCalled();
  });

  it("returns runtimeDiagnostics.codexEmptyOutput for non-zero runs with no item.completed output", async () => {
    const auditSql = { json: vi.fn((value) => value) } as never;
    const adapter = new CodexAdapter(auditSql);
    const ctx = makeCtx();
    ctx.task.brief = "Do not leak SECRET_PROMPT_BODY";
    ctx.model = "openai-codex/gpt-5.5";
    ctx.task.adapterOverride = "codex";

    const stdout = JSON.stringify({
      type: "turn.failed",
      thread_id: "019dd0b1-0f3a-7313-b737-93d8967819fb",
      request_id: "req_123",
      prompt: "SECRET_PROMPT_BODY",
      output: "MODEL_OUTPUT_BODY",
      error: {
        code: "terminal_error",
        message: "codex reported error with sk-livecredential123456",
        type: "internal",
        id: "err_456",
        details: "MODEL_OUTPUT_BODY",
      },
    });
    const stderr =
      "codex_core::session: failed to record rollout items: thread 019dd0b1-0f3a-7313-b737-93d8967819fb not found";

    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from(stdout));
        proc.stderr.emit("data", Buffer.from(stderr));
        proc.emit("close", 1);
      });
      return proc;
    });

    const result = await adapter.execute(ctx);

    expect(result.success).toBe(false);
    expect(result.runtimeDiagnostics?.codexEmptyOutput).toMatchObject({
      kind: "codex_empty_output",
      schemaVersion: 1,
      codexEmptyOutput: true,
      exitCode: 1,
      effectiveAdapter: "codex",
      adapterOverride: "codex",
      modelSlug: "openai-codex/gpt-5.5",
      modelProviderMismatchDetected: false,
      cwd: "/tmp/test-workspace",
      taskWorkspace: "/tmp/test-workspace",
      rolloutSignaturePresent: true,
      truncated: false,
    });
    expect(result.runtimeDiagnostics?.codexEmptyOutput?.terminalEvents).toEqual([
      {
        type: "turn.failed",
        ids: {
          thread_id: "019dd0b1-0f3a-7313-b737-93d8967819fb",
          request_id: "req_123",
        },
        error: {
          code: "terminal_error",
          message: "codex reported error with [REDACTED]",
          type: "internal",
          id: "err_456",
        },
      },
    ]);
    expect(mockRecordAgentAuditEventBestEffort).toHaveBeenCalledTimes(1);
    const [, auditInput] = mockRecordAgentAuditEventBestEffort.mock.calls[0];
    expect(auditInput).toMatchObject({
      eventType: "codex_empty_output_failure",
      taskId: "t-1",
      targetType: "adapter_run",
      targetId: "t-1",
      outcome: "error",
      metadata: {
        exitCode: 1,
        effectiveAdapter: "codex",
        adapterOverride: "codex",
        modelSlug: "openai-codex/gpt-5.5",
        modelProviderMismatchDetected: false,
        cwd: "/tmp/test-workspace",
        rolloutRegistrationSignaturePresent: true,
      },
    });
    expect(auditInput.metadata.codexEvents).toEqual([
      {
        type: "turn.failed",
        ids: {
          thread_id: "019dd0b1-0f3a-7313-b737-93d8967819fb",
          request_id: "req_123",
        },
        error: {
          code: "terminal_error",
          message: "codex reported error with [REDACTED]",
          type: "internal",
          id: "err_456",
        },
      },
    ]);
    const serializedAudit = JSON.stringify(auditInput);
    expect(serializedAudit).not.toContain("SECRET_PROMPT_BODY");
    expect(serializedAudit).not.toContain("MODEL_OUTPUT_BODY");
    expect(serializedAudit).not.toContain("sk-livecredential123456");
  });

  it("redacts prompt output credentials and outside-workspace paths from codex empty-output diagnostics", () => {
    const diagnostic = buildCodexEmptyOutputDiagnostic({
      rawStdout: JSON.stringify({
        type: "turn.failed",
        thread_id: "thread-1",
        error: {
          message: [
            "OPENAI_API_KEY=sk-livecredential123456",
            "Authorization: Bearer abc.def.ghi",
            "Cookie: session=secret",
            "/home/hivewright/.codex/auth.json",
            "/tmp/test-workspace/src/app.ts",
          ].join(" "),
        },
      }),
      stderr: [
        "failed to record rollout items: thread thread-1 not found",
        "GH_TOKEN=githubtoken123",
        "PASSWORD=hunter2",
        "/home/hivewright/.ssh/id_rsa",
        "/tmp/test-workspace/package.json",
      ].join("\n"),
      exitCode: 1,
      effectiveAdapter: "codex",
      adapterOverride: "codex",
      modelSlug: "openai-codex/gpt-5.5",
      modelProviderMismatchDetected: false,
      cwd: "/home/hivewright/outside-repo",
      taskWorkspace: "/tmp/test-workspace",
      rolloutSignaturePresent: true,
    });

    const serialized = JSON.stringify(diagnostic);
    expect(diagnostic.cwd).toBe("[REDACTED_OUTSIDE_WORKSPACE]");
    expect(diagnostic.effectiveAdapter).toBe("codex");
    expect(diagnostic.adapterOverride).toBe("codex");
    expect(diagnostic.modelProviderMismatchDetected).toBe(false);
    expect(serialized).toContain("[REDACTED_HOME_PATH]");
    expect(serialized).toContain("/tmp/test-workspace/package.json");
    expect(serialized).not.toContain("sk-livecredential123456");
    expect(serialized).not.toContain("githubtoken123");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("Bearer abc.def.ghi");
    expect(serialized).not.toContain("session=secret");
    expect(serialized).not.toContain("/home/hivewright/.ssh/id_rsa");
  });

  it("caps codex empty-output diagnostics at 8192 bytes with explicit truncation marker", () => {
    const rawStdout = Array.from({ length: 30 }, (_, i) => JSON.stringify({
      type: "turn.failed",
      thread_id: `thread-${i}`,
      error: { message: `error-${i} ${"x".repeat(1200)}` },
    })).join("\n");

    const diagnostic = buildCodexEmptyOutputDiagnostic({
      rawStdout,
      stderr: "stderr\n" + "y".repeat(20_000),
      exitCode: 1,
      modelSlug: "openai-codex/gpt-5.5",
      cwd: "/tmp/test-workspace",
      taskWorkspace: "/tmp/test-workspace",
      rolloutSignaturePresent: false,
    });

    expect(Buffer.byteLength(JSON.stringify(diagnostic), "utf8")).toBeLessThanOrEqual(8192);
    expect(diagnostic.truncated).toBe(true);
    expect(diagnostic.truncationMarker).toBe("[...TRUNCATED_CODEX_EMPTY_OUTPUT_DIAGNOSTIC_8192_BYTES]");
    for (const event of diagnostic.terminalEvents) {
      expect(event.error.message?.length ?? 0).toBeLessThanOrEqual(1000);
    }
  });

  it("does not attach codex empty-output diagnostics to salvageable rollout-registration failures with agent output", async () => {
    const adapter = new CodexAdapter({ json: vi.fn((value) => value) } as never);
    const stdout = JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Captured work before rollout failure." },
    });
    const stderr = "failed to record rollout items: thread thread-1 not found";

    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from(stdout));
        proc.stderr.emit("data", Buffer.from(stderr));
        proc.emit("close", 1);
      });
      return proc;
    });

    const result = await adapter.execute(makeCtx());

    expect(result.success).toBe(true);
    expect(result.runtimeWarnings).toEqual([
      "Codex rollout registration failed after agent output was captured; HiveWright persisted stdout directly and QA should verify the recorded tail.",
    ]);
    expect(result.runtimeDiagnostics?.codexEmptyOutput).toBeUndefined();
  });

  it("does not persist empty-output diagnostics for successful item.completed runs", async () => {
    const adapter = new CodexAdapter({ json: vi.fn((value) => value) } as never);
    const stdout = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Completed work." } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }),
    ].join("\n");

    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from(stdout));
        proc.emit("close", 0);
      });
      return proc;
    });

    const result = await adapter.execute(makeCtx());

    expect(result.success).toBe(true);
    expect(result.output).toBe("Completed work.");
    expect(mockRecordAgentAuditEventBestEffort).not.toHaveBeenCalled();
  });

  describe("workspace isolation cwd handling", () => {
    function makeIsolationCtx(opts: {
      status: "active" | "skipped" | "failed";
      worktreePath: string | null;
      basePath?: string;
    }): SessionContext {
      const ctx = makeCtx();
      const basePath = opts.basePath ?? "/tmp/test-base-canonical";
      ctx.projectWorkspace = basePath;
      ctx.baseProjectWorkspace = basePath;
      ctx.workspaceIsolation = {
        status: opts.status,
        baseWorkspacePath: basePath,
        worktreePath: opts.worktreePath,
        branchName: "hw/isolation-test",
        isolationActive: opts.status === "active" && Boolean(opts.worktreePath),
        reused: false,
        reason: null,
      };
      return ctx;
    }

    function mockOkSpawn() {
      mockSpawn.mockImplementation(() => {
        const proc = new EventEmitter() as EventEmitter & {
          stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
          stdout: EventEmitter;
          stderr: EventEmitter;
        };
        proc.stdin = { write: vi.fn(), end: vi.fn() };
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        queueMicrotask(() => {
          proc.stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({
                type: "item.completed",
                item: { type: "agent_message", text: "ok" },
              }) + "\n",
            ),
          );
          proc.emit("close", 0);
        });
        return proc;
      });
    }

    it("uses workspaceIsolation.worktreePath for -C when isolation is active", () => {
      const adapter = new CodexAdapter();
      const worktreePath = "/tmp/test-base-canonical/.claude/worktrees/task-active";
      const ctx = makeIsolationCtx({ status: "active", worktreePath });
      const args = adapter.buildCommand(ctx);
      const cIdx = args.indexOf("-C");
      expect(cIdx).toBeGreaterThanOrEqual(0);
      expect(args[cIdx + 1]).toBe(worktreePath);
      expect(args[cIdx + 1]).not.toBe(ctx.projectWorkspace);
    });

    it("falls back to projectWorkspace for -C when isolation status is skipped", () => {
      const adapter = new CodexAdapter();
      const ctx = makeIsolationCtx({
        status: "skipped",
        worktreePath: "/tmp/test-base-canonical/.claude/worktrees/should-not-be-used",
      });
      const args = adapter.buildCommand(ctx);
      const cIdx = args.indexOf("-C");
      expect(cIdx).toBeGreaterThanOrEqual(0);
      expect(args[cIdx + 1]).toBe(ctx.projectWorkspace);
      expect(args[cIdx + 1]).not.toBe(ctx.workspaceIsolation?.worktreePath);
    });

    it("falls back to projectWorkspace for -C when isolation status is failed", () => {
      const adapter = new CodexAdapter();
      const ctx = makeIsolationCtx({
        status: "failed",
        worktreePath: "/tmp/test-base-canonical/.claude/worktrees/should-not-be-used",
      });
      const args = adapter.buildCommand(ctx);
      const cIdx = args.indexOf("-C");
      expect(args[cIdx + 1]).toBe(ctx.projectWorkspace);
      expect(args[cIdx + 1]).not.toBe(ctx.workspaceIsolation?.worktreePath);
    });

    it("falls back to projectWorkspace for -C when active isolation lacks worktreePath", () => {
      const adapter = new CodexAdapter();
      const ctx = makeIsolationCtx({ status: "active", worktreePath: null });
      const args = adapter.buildCommand(ctx);
      const cIdx = args.indexOf("-C");
      expect(args[cIdx + 1]).toBe(ctx.projectWorkspace);
    });

    it("spawns codex with cwd set to worktreePath when isolation is active and preserves base metadata", async () => {
      const adapter = new CodexAdapter();
      const worktreePath = "/tmp/test-base-canonical/.claude/worktrees/task-spawn-active";
      const basePath = "/tmp/test-base-canonical";
      const ctx = makeIsolationCtx({ status: "active", worktreePath, basePath });
      mockOkSpawn();

      await adapter.execute(ctx);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [, args, opts] = mockSpawn.mock.calls[0] as [string, string[], { cwd?: string }];
      expect(opts.cwd).toBe(worktreePath);
      const cIdx = args.indexOf("-C");
      expect(args[cIdx + 1]).toBe(worktreePath);
      expect(ctx.baseProjectWorkspace).toBe(basePath);
      expect(ctx.workspaceIsolation?.baseWorkspacePath).toBe(basePath);
    });

    it("spawns codex with cwd set to projectWorkspace when isolation is skipped", async () => {
      const adapter = new CodexAdapter();
      const ctx = makeIsolationCtx({
        status: "skipped",
        worktreePath: "/tmp/test-base-canonical/.claude/worktrees/should-not-be-used",
      });
      mockOkSpawn();

      await adapter.execute(ctx);

      const [, args, opts] = mockSpawn.mock.calls[0] as [string, string[], { cwd?: string }];
      expect(opts.cwd).toBe(ctx.projectWorkspace);
      const cIdx = args.indexOf("-C");
      expect(args[cIdx + 1]).toBe(ctx.projectWorkspace);
    });

    it("spawns codex with cwd set to projectWorkspace when isolation is failed", async () => {
      const adapter = new CodexAdapter();
      const ctx = makeIsolationCtx({
        status: "failed",
        worktreePath: "/tmp/test-base-canonical/.claude/worktrees/should-not-be-used",
      });
      mockOkSpawn();

      await adapter.execute(ctx);

      const [, args, opts] = mockSpawn.mock.calls[0] as [string, string[], { cwd?: string }];
      expect(opts.cwd).toBe(ctx.projectWorkspace);
      const cIdx = args.indexOf("-C");
      expect(args[cIdx + 1]).toBe(ctx.projectWorkspace);
    });
  });
});
