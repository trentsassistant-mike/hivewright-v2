import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContext } from "./types";
import { GeminiAdapter, normalizeGeminiModelId, parseGeminiStreamJson } from "./gemini";
import { buildGeminiMcpSettings, resolveMcps } from "../tools/mcp-catalog";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("child_process", () => ({ spawn: mockSpawn }));

describe("GeminiAdapter", () => {
  it("normalizes provider-prefixed Gemini model IDs for the CLI", () => {
    expect(normalizeGeminiModelId("google/gemini-3.1-flash-lite-preview")).toBe("gemini-3.1-flash-lite-preview");
    expect(normalizeGeminiModelId("gemini-2.5-flash")).toBe("gemini-2.5-flash");
  });

  it("builds the official non-interactive command and injects five-layer prompt content", () => {
    const adapter = new GeminiAdapter();
    const args = adapter.buildCommand(makeContext());

    expect(args).toEqual([
      "--model", "gemini-3.1-flash-lite-preview",
      "--prompt", "",
      "--output-format", "stream-json",
      "--approval-mode", "yolo",
      "--skip-trust",
    ]);

    const prompt = adapter.translate(makeContext());
    expect(prompt).toContain("# Role");
    expect(prompt).toContain("# Task: Adapter task");
    expect(prompt).toContain("## Memory [Role Memory: 1/200]");
    expect(prompt).toContain("## Relevant Skills");
    expect(prompt).toContain("## Standing Instructions");
  });

  it("parses assistant text, token stats, and model from stream-json output", () => {
    const parsed = parseGeminiStreamJson([
      JSON.stringify({ type: "init", model: "gemini-3.1-flash-lite-preview" }),
      JSON.stringify({ type: "message", role: "assistant", content: "Done" }),
      JSON.stringify({
        type: "result",
        status: "success",
        stats: {
          input_tokens: 1200,
          output_tokens: 300,
          models: { "gemini-3.1-flash-lite-preview": { input_tokens: 1200, output_tokens: 300 } },
        },
      }),
    ].join("\n"));

    expect(parsed.text).toBe("Done");
    expect(parsed.result).toEqual({
      isError: false,
      errorMessage: undefined,
      tokensInput: 1200,
      tokensOutput: 300,
      modelUsed: "google/gemini-3.1-flash-lite-preview",
    });
  });

  it("renders Gemini MCP settings from the shared catalog shape", () => {
    const settings = buildGeminiMcpSettings(resolveMcps(["context7"]));

    expect(settings).toEqual({
      mcpServers: {
        context7: {
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
        },
      },
    });
  });

  describe("probe", () => {
    type FakeProc = EventEmitter & {
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };

    function makeFakeProc(opts: {
      onSigkill?: (proc: FakeProc) => void;
      onSigterm?: (proc: FakeProc) => void;
    } = {}): FakeProc {
      const proc = new EventEmitter() as FakeProc;
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn((sig?: string) => {
        if (sig === "SIGKILL") opts.onSigkill?.(proc);
        else opts.onSigterm?.(proc);
        return true;
      });
      return proc;
    }

    beforeEach(() => {
      mockSpawn.mockReset();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("classifies a quota result envelope (gemini 429 capacity message) as failureClass=quota", async () => {
      mockSpawn.mockImplementation(() => {
        const proc = makeFakeProc();
        queueMicrotask(() => {
          proc.stdout.emit("data", Buffer.from(
            JSON.stringify({ type: "init", model: "gemini-3.1-pro-preview" }) + "\n" +
            JSON.stringify({
              type: "result",
              status: "error",
              error: { type: "unknown", message: "[API Error: You have exhausted your capacity on this model.]" },
            }) + "\n",
            "utf-8",
          ));
          proc.emit("close", 1);
        });
        return proc;
      });

      const result = await new GeminiAdapter().probe("google/gemini-3.1-pro-preview", {
        provider: "google",
        secrets: {},
      });

      expect(result).toMatchObject({
        healthy: false,
        status: "unhealthy",
        failureClass: "quota",
        reason: { code: "quota_exhausted", retryable: true },
      });
    });

    it("escalates to SIGKILL and resolves with a bounded timeout result if the gemini CLI does not exit on its own", async () => {
      vi.useFakeTimers();
      let captured: FakeProc | null = null;
      mockSpawn.mockImplementation(() => {
        const proc = makeFakeProc({
          onSigkill: (p) => {
            // SIGKILL is non-trappable — the kernel kills the process and Node
            // emits close almost immediately.
            queueMicrotask(() => p.emit("close", null, "SIGKILL"));
          },
        });
        captured = proc;
        return proc;
      });

      const probePromise = new GeminiAdapter().probe("google/gemini-3.1-pro-preview", {
        provider: "google",
        secrets: {},
      });

      // Fast-forward past the probe's hard cutoff. Anything > 60s should trip
      // the SIGTERM, anything > 75s should trip the SIGKILL escalation.
      await vi.advanceTimersByTimeAsync(80_000);

      const result = await probePromise;
      expect(captured).not.toBeNull();
      const killSignals = (captured!.kill.mock.calls as Array<[string | undefined]>).map(
        ([sig]) => sig ?? "SIGTERM",
      );
      expect(killSignals).toContain("SIGKILL");
      expect(result.healthy).toBe(false);
      expect(result.failureClass).toBe("timeout");
    });
  });
});

function makeContext(): SessionContext {
  return {
    task: {
      id: "task-1",
      hiveId: "hive-1",
      assignedTo: "dev-agent",
      createdBy: "owner",
      status: "active",
      priority: 1,
      title: "Adapter task",
      brief: "Implement Gemini.",
      parentTaskId: null,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: "Works",
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    },
    roleTemplate: {
      slug: "dev-agent",
      department: "engineering",
      roleMd: "# Role",
      soulMd: "Be precise.",
      toolsMd: null,
    },
    memoryContext: {
      roleMemory: [{ content: "Remember adapters.", confidence: 0.9, updatedAt: new Date("2026-04-27T00:00:00Z") }],
      hiveMemory: [],
      insights: [],
      capacity: "1/200",
    },
    skills: ["# Skill\nUse the skill."],
    standingInstructions: ["Commit changes."],
    goalContext: "Goal: Gemini adapter",
    projectWorkspace: "/tmp/hivewright",
    hiveContext: "## Hive Context\nHiveWright",
    model: "google/gemini-3.1-flash-lite-preview",
    fallbackModel: null,
    credentials: {},
    toolsConfig: { mcps: ["context7"] },
  };
}
