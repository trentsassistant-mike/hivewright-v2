import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "@/adapters/claude-code";
import { CodexAdapter } from "@/adapters/codex";
import { GeminiAdapter } from "@/adapters/gemini";
import { OllamaAdapter } from "@/adapters/ollama";
import { OpenAIImageAdapter } from "@/adapters/openai-image";
import { OpenClawAdapter } from "@/adapters/openclaw";
import type { AdapterProbe } from "@/adapters/types";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: mockSpawn,
}));

vi.mock("@/audit/agent-events", () => ({
  AGENT_AUDIT_EVENTS: { codexEmptyOutputFailure: "codex.empty_output" },
  recordAgentAuditEventBestEffort: vi.fn(),
}));

type FakeProc = EventEmitter & {
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  mockSpawn.mockReset();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function fakeSpawn(opts: { exitCode: number; stdout?: string; stderr?: string; error?: Error }) {
  mockSpawn.mockImplementation(() => {
    const proc = new EventEmitter() as FakeProc;
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (opts.error) {
        proc.emit("error", opts.error);
        return;
      }
      if (opts.stdout) proc.stdout.emit("data", Buffer.from(opts.stdout, "utf-8"));
      if (opts.stderr) proc.stderr.emit("data", Buffer.from(opts.stderr, "utf-8"));
      proc.emit("close", opts.exitCode);
    });
    return proc;
  });
}

describe("adapter probe implementations", () => {
  it("all concrete adapters implement the shared probe contract", () => {
    const probes = {
      "claude-code": new ClaudeCodeAdapter(),
      codex: new CodexAdapter(),
      gemini: new GeminiAdapter(),
      ollama: new OllamaAdapter(),
      "openai-image": new OpenAIImageAdapter({ fetch: vi.fn() as unknown as typeof fetch }),
      openclaw: new OpenClawAdapter(),
    } satisfies Record<string, AdapterProbe>;

    expect(Object.keys(probes).sort()).toEqual([
      "claude-code",
      "codex",
      "gemini",
      "ollama",
      "openai-image",
      "openclaw",
    ]);
  });

  it("Claude Code probes via the claude CLI (matching the dispatcher's spawn auth path) and classifies CLI auth failure", async () => {
    fakeSpawn({ exitCode: 1, stderr: "Invalid API key. Please log in with `claude login`." });

    const result = await new ClaudeCodeAdapter().probe("anthropic/claude-sonnet-4-6", {
      provider: "anthropic",
      secrets: {},
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["--print", "--model", "claude-sonnet-4-6"]),
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
    expect(result).toMatchObject({
      healthy: false,
      status: "unhealthy",
      failureClass: "auth",
      reason: { code: "auth_failed" },
    });
  });

  it("Codex probes through codex exec and classifies rollout session failure", async () => {
    fakeSpawn({
      exitCode: 0,
      stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n',
      stderr: "WARN failed to record rollout items: thread t-1 not found",
    });

    const result = await new CodexAdapter().probe("openai-codex/gpt-5.5", {
      provider: "openai-codex",
      secrets: {},
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "codex",
      expect.arrayContaining(["exec", "--json", "-m", "gpt-5.5"]),
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
    expect(result).toMatchObject({
      healthy: false,
      failureClass: "runtime_session",
      reason: { code: "codex_rollout_thread_not_found" },
    });
  });

  it("Gemini probes through the Gemini CLI and classifies quota errors", async () => {
    fakeSpawn({
      exitCode: 1,
      stdout: JSON.stringify({
        type: "result",
        status: "error",
        error: { message: "RESOURCE_EXHAUSTED: quota exceeded" },
      }),
    });

    const result = await new GeminiAdapter().probe("google/gemini-2.5-flash", {
      provider: "google",
      secrets: { GEMINI_API_KEY: "gemini-test" },
    });

    expect(mockSpawn).toHaveBeenCalledWith(
      "gemini",
      expect.arrayContaining(["--model", "gemini-2.5-flash"]),
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
    expect(result).toMatchObject({
      healthy: false,
      failureClass: "quota",
      reason: { code: "quota_exhausted" },
    });
  });

  it("Ollama probes local model availability", async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      models: [{ name: "qwen3:32b" }],
    }), { status: 200 }));

    const result = await new OllamaAdapter().probe("ollama/qwen3:32b", {
      provider: "ollama",
      baseUrl: "http://ollama.test:11434",
      secrets: {},
    });

    expect(globalThis.fetch).toHaveBeenCalledWith("http://ollama.test:11434/api/tags", expect.any(Object));
    expect(result).toMatchObject({
      healthy: true,
      status: "healthy",
      failureClass: null,
      costEstimateUsd: 0,
    });
  });

  it("OpenAI image probes image API auth/scope using the configured API key", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("insufficient_scope", { status: 403 }));
    const result = await new OpenAIImageAdapter({ fetch: fetchMock }).probe("gpt-image-2", {
      provider: "openai",
      secrets: { OPENAI_API_KEY: "sk-test" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
      }),
    );
    expect(result).toMatchObject({
      healthy: false,
      failureClass: "scope",
      reason: { code: "scope_denied" },
    });
  });

  it("OpenClaw reports retired gateway without spawning work", async () => {
    const result = await new OpenClawAdapter().probe("anthropic/claude-sonnet-4-6", {
      provider: "openclaw",
      secrets: {},
    });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      healthy: false,
      failureClass: "gateway_retired",
      reason: {
        code: "gateway_retired",
        retryable: false,
      },
    });
  });
});
