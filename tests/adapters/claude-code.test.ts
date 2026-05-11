import { EventEmitter } from "events";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { ClaudeCodeAdapter, resolveClaudeCodeWorkspace } from "@/adapters/claude-code";
import type { SessionContext, RoleContext, MemoryContext } from "@/adapters/types";
import type { ClaimedTask } from "@/dispatcher/types";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: mockSpawn,
}));

beforeEach(() => {
  mockSpawn.mockReset();
});

function makeCtx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    task: {
      id: "test-task-id",
      hiveId: "test-biz-id",
      assignedTo: "dev-agent",
      createdBy: "owner",
      status: "active",
      priority: 5,
      title: "Build login page",
      brief: "Create a login page with email/password fields",
      parentTaskId: null,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: "Form renders and submits",
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
    } as ClaimedTask,
    roleTemplate: {
      slug: "dev-agent",
      department: "engineering",
      roleMd: "# Developer\nYou write code.",
      soulMd: "You are methodical.",
      toolsMd: "# Tools\nFile system, git.",
    } as RoleContext,
    memoryContext: {
      roleMemory: [],
      hiveMemory: [],
      insights: [],
      capacity: "0/200",
    } as MemoryContext,
    skills: [],
    standingInstructions: [],
    goalContext: null,
    projectWorkspace: "/tmp",
    model: "anthropic/claude-sonnet-4-6",
    fallbackModel: null,
    credentials: {},
    ...overrides,
  };
}

describe("ClaudeCodeAdapter", () => {
  const adapter = new ClaudeCodeAdapter();

  function mockSuccessfulSpawn() {
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdin = { write: vi.fn(), end: vi.fn() };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      queueMicrotask(() => proc.emit("close", 0));
      return proc;
    });
  }

  describe("translate", () => {
    it("builds a prompt with all 5 context layers", () => {
      const ctx = makeCtx();
      const prompt = adapter.translate(ctx);

      // Layer 1: Identity
      expect(prompt).toContain("# Developer");
      expect(prompt).toContain("You are methodical");
      expect(prompt).toContain("File system, git");

      // Layer 2: Task
      expect(prompt).toContain("Build login page");
      expect(prompt).toContain("Create a login page");
      expect(prompt).toContain("Form renders and submits");

      // Layer 3: Memory header present even when empty
      expect(prompt).toContain("Memory");
    });

    it("includes memory when available", () => {
      const ctx = makeCtx({
        memoryContext: {
          roleMemory: [{ content: "Use TypeScript strict mode", confidence: 0.9, updatedAt: new Date() }],
          hiveMemory: [{ content: "Easter is peak season", category: "seasonal", confidence: 1.0 }],
          insights: [{ content: "SEO traffic mismatch", connectionType: "opportunity", confidence: 0.8 }],
          capacity: "42/200",
        },
      });
      const prompt = adapter.translate(ctx);

      expect(prompt).toContain("Use TypeScript strict mode");
      expect(prompt).toContain("Easter is peak season");
      expect(prompt).toContain("SEO traffic mismatch");
      expect(prompt).toContain("42/200");
    });

    it("includes goal context when present", () => {
      const ctx = makeCtx({ goalContext: "Goal: Rebuild the website\nMake it modern and fast" });
      const prompt = adapter.translate(ctx);
      expect(prompt).toContain("Rebuild the website");
    });

    it("renders structured image work product context for Claude image-read", () => {
      const ctx = makeCtx({
        imageWorkProducts: [
          {
            workProductId: "10000000-0000-4000-8000-000000000001",
            taskId: "10000000-0000-4000-8000-000000000002",
            roleSlug: "image-designer",
            path: "/tmp/hive/task/images/hero.png",
            diskPath: "/tmp/hive/task/images/hero.png",
            imageRead: {
              type: "local_image",
              path: "/tmp/hive/task/images/hero.png",
              mimeType: "image/png",
            },
            mimeType: "image/png",
            dimensions: { width: 1536, height: 864 },
            model: { name: "gpt-image-2", snapshot: "gpt-image-2-2026-04-21" },
            usage: { promptTokens: 2100, outputTokens: 900, costCents: 4 },
            originalImageBrief: {
              taskTitle: "Generate hero",
              taskBrief: "Make a vibrant hive hero",
              prompt: "vibrant hive hero",
            },
            metadata: { originalPrompt: "vibrant hive hero" },
          },
        ],
      });
      const prompt = adapter.translate(ctx);
      expect(prompt).toContain("## Image Work Products");
      expect(prompt).toContain("image-read capability");
      expect(prompt).toContain('"workProductId": "10000000-0000-4000-8000-000000000001"');
      expect(prompt).toContain('"path": "/tmp/hive/task/images/hero.png"');
      expect(prompt).toContain('"type": "local_image"');
      expect(prompt).toContain('"diskPath": "/tmp/hive/task/images/hero.png"');
      expect(prompt).toContain('"snapshot": "gpt-image-2-2026-04-21"');
      expect(prompt).toContain('"prompt": "vibrant hive hero"');
    });

    it("includes standing instructions when present", () => {
      const ctx = makeCtx({ standingInstructions: ["Always use Australian English spelling"] });
      const prompt = adapter.translate(ctx);
      expect(prompt).toContain("Australian English");
    });

    it("uses the effective worktree path in the working-directory prompt only for active isolation", () => {
      const ctx = makeCtx({
        projectWorkspace: "/repo/base",
        baseProjectWorkspace: "/repo/base",
        worktreeContext: {
          baseWorkspace: "/repo/base",
          effectiveWorkspace: "/repo/base/.claude/worktrees/task-1",
          branch: "hw/task-1",
          isolationStatus: "active",
          worktreePath: "/repo/base/.claude/worktrees/task-1",
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
          reusedAt: new Date("2026-05-01T00:00:00.000Z"),
          failureReason: null,
        },
      });

      const prompt = adapter.translate(ctx);

      expect(prompt).toContain("`/repo/base/.claude/worktrees/task-1`");
      expect(prompt).not.toContain("`/repo/base`");
      expect(ctx.baseProjectWorkspace).toBe("/repo/base");
      expect(ctx.worktreeContext?.baseWorkspace).toBe("/repo/base");
    });
  });

  describe("buildCommand", () => {
    it("returns claude CLI args for stream-json mode", () => {
      const ctx = makeCtx();
      const args = adapter.buildCommand(ctx);
      expect(args).toContain("--print");
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      // stream-json requires --verbose
      expect(args).toContain("--verbose");
      // partial messages give us per-token deltas instead of per-block dumps
      expect(args).toContain("--include-partial-messages");
    });

    it("sets model flag from session context", () => {
      const ctx = makeCtx({ model: "anthropic/claude-sonnet-4-6" });
      const args = adapter.buildCommand(ctx);
      expect(args).toContain("--model");
      expect(args).toContain("claude-sonnet-4-6");
    });

    it("does not request the buffered json envelope", () => {
      const ctx = makeCtx();
      const args = adapter.buildCommand(ctx);
      // We use stream-json now; make sure we don't accidentally regress.
      const formatIdx = args.indexOf("--output-format");
      expect(args[formatIdx + 1]).toBe("stream-json");
    });

    it("injects --mcp-config + --strict-mcp-config when toolsConfig.mcps is set", () => {
      const ctx = makeCtx({ toolsConfig: { mcps: ["context7", "playwright"] } });
      const args = adapter.buildCommand(ctx);
      const mcpIdx = args.indexOf("--mcp-config");
      expect(mcpIdx).toBeGreaterThanOrEqual(0);
      const cfg = JSON.parse(args[mcpIdx + 1]);
      expect(Object.keys(cfg.mcpServers).sort()).toEqual(["context7", "playwright"]);
      expect(args).toContain("--strict-mcp-config");
    });

    it("locks down all MCPs when toolsConfig.mcps is an empty array", () => {
      const ctx = makeCtx({ toolsConfig: { mcps: [] } });
      const args = adapter.buildCommand(ctx);
      const mcpIdx = args.indexOf("--mcp-config");
      const cfg = JSON.parse(args[mcpIdx + 1]);
      expect(cfg.mcpServers).toEqual({});
      expect(args).toContain("--strict-mcp-config");
    });

    it("appends --allowed-tools when toolsConfig.allowedTools is set", () => {
      const ctx = makeCtx({ toolsConfig: { mcps: ["context7"], allowedTools: ["Bash", "Read"] } });
      const args = adapter.buildCommand(ctx);
      const tIdx = args.indexOf("--allowed-tools");
      expect(tIdx).toBeGreaterThanOrEqual(0);
      expect(args[tIdx + 1]).toBe("Bash,Read");
    });

    it("does not inject any --mcp-config when toolsConfig is null (backwards compat)", () => {
      const ctx = makeCtx({ toolsConfig: null });
      const args = adapter.buildCommand(ctx);
      expect(args).not.toContain("--mcp-config");
      expect(args).not.toContain("--strict-mcp-config");
    });
  });

  describe("workspace resolution", () => {
    it("resolves active isolation cwd from worktreeContext.effectiveWorkspace", () => {
      const ctx = makeCtx({
        projectWorkspace: "/repo/base",
        baseProjectWorkspace: "/repo/base",
        worktreeContext: {
          baseWorkspace: "/repo/base",
          effectiveWorkspace: "/repo/base/.claude/worktrees/task-1",
          branch: "hw/task-1",
          isolationStatus: "active",
          worktreePath: "/repo/base/.claude/worktrees/task-1",
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
          reusedAt: new Date("2026-05-01T00:00:00.000Z"),
          failureReason: null,
        },
      });

      expect(resolveClaudeCodeWorkspace(ctx)).toBe("/repo/base/.claude/worktrees/task-1");
      expect(ctx.baseProjectWorkspace).toBe("/repo/base");
      expect(ctx.worktreeContext?.baseWorkspace).toBe("/repo/base");
    });

    it("keeps legacy projectWorkspace cwd when isolation is absent", () => {
      expect(resolveClaudeCodeWorkspace(makeCtx({ projectWorkspace: "/repo/base" }))).toBe("/repo/base");
    });

    it("keeps projectWorkspace cwd when worktree isolation is not active", () => {
      const ctx = makeCtx({
        projectWorkspace: "/repo/base",
        worktreeContext: {
          baseWorkspace: "/repo/base",
          effectiveWorkspace: "/repo/base/.claude/worktrees/task-1",
          branch: "hw/task-1",
          isolationStatus: "skipped",
          worktreePath: "/repo/base/.claude/worktrees/task-1",
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
          reusedAt: new Date("2026-05-01T00:00:00.000Z"),
          failureReason: "not a git work tree",
        },
      });

      expect(resolveClaudeCodeWorkspace(ctx)).toBe("/repo/base");
    });
  });

  describe("execute", () => {
    it("spawns claude in the active effective worktree cwd", async () => {
      mockSuccessfulSpawn();
      const ctx = makeCtx({
        projectWorkspace: "/repo/base",
        baseProjectWorkspace: "/repo/base",
        worktreeContext: {
          baseWorkspace: "/repo/base",
          effectiveWorkspace: "/repo/base/.claude/worktrees/task-1",
          branch: "hw/task-1",
          isolationStatus: "active",
          worktreePath: "/repo/base/.claude/worktrees/task-1",
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
          reusedAt: new Date("2026-05-01T00:00:00.000Z"),
          failureReason: null,
        },
      });

      await adapter.execute(ctx);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn.mock.calls[0][2].cwd).toBe("/repo/base/.claude/worktrees/task-1");
      expect(ctx.baseProjectWorkspace).toBe("/repo/base");
      expect(ctx.worktreeContext?.baseWorkspace).toBe("/repo/base");
    });

    it("spawns claude in projectWorkspace when isolation is skipped", async () => {
      mockSuccessfulSpawn();
      const ctx = makeCtx({
        projectWorkspace: "/repo/base",
        worktreeContext: {
          baseWorkspace: "/repo/base",
          effectiveWorkspace: "/repo/base/.claude/worktrees/task-1",
          branch: "hw/task-1",
          isolationStatus: "skipped",
          worktreePath: "/repo/base/.claude/worktrees/task-1",
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
          reusedAt: new Date("2026-05-01T00:00:00.000Z"),
          failureReason: "not a git work tree",
        },
      });

      await adapter.execute(ctx);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn.mock.calls[0][2].cwd).toBe("/repo/base");
    });

    it("derives spawn cwd from session context and never hardcodes /workspace/hivewrightv2", async () => {
      mockSuccessfulSpawn();
      const uniqueBase = "/var/tmp/synthetic-hive-root";
      const uniqueWorktree = "/var/tmp/synthetic-hive-root/.claude/worktrees/regression-task";
      const ctx = makeCtx({
        projectWorkspace: uniqueBase,
        baseProjectWorkspace: uniqueBase,
        worktreeContext: {
          baseWorkspace: uniqueBase,
          effectiveWorkspace: uniqueWorktree,
          branch: "hw/regression-task",
          isolationStatus: "active",
          worktreePath: uniqueWorktree,
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
          reusedAt: new Date("2026-05-01T00:00:00.000Z"),
          failureReason: null,
        },
      });

      await adapter.execute(ctx);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const spawnedCwd = mockSpawn.mock.calls[0][2].cwd as string;
      expect(spawnedCwd).toBe(uniqueWorktree);
      expect(spawnedCwd).not.toContain("/workspace/hivewrightv2");
      expect(resolveClaudeCodeWorkspace(ctx)).toBe(uniqueWorktree);
      expect(resolveClaudeCodeWorkspace(ctx)).not.toContain("/workspace/hivewrightv2");
      expect(ctx.baseProjectWorkspace).toBe(uniqueBase);
      expect(ctx.worktreeContext?.baseWorkspace).toBe(uniqueBase);
    });

    it("falls back to projectWorkspace when worktreeContext is active but effectiveWorkspace is empty", async () => {
      mockSuccessfulSpawn();
      const ctx = makeCtx({
        projectWorkspace: "/repo/base",
        baseProjectWorkspace: "/repo/base",
        worktreeContext: {
          baseWorkspace: "/repo/base",
          effectiveWorkspace: "",
          branch: "hw/task-1",
          isolationStatus: "active",
          worktreePath: "/repo/base/.claude/worktrees/task-1",
          createdAt: new Date("2026-05-01T00:00:00.000Z"),
          reusedAt: new Date("2026-05-01T00:00:00.000Z"),
          failureReason: null,
        },
      });

      await adapter.execute(ctx);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn.mock.calls[0][2].cwd).toBe("/repo/base");
      expect(ctx.worktreeContext?.baseWorkspace).toBe("/repo/base");
    });
  });

  describe("probe", () => {
    function fakeProbeSpawn(opts: { exitCode: number; stdout?: string; stderr?: string; error?: Error }) {
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

    it("spawns the claude CLI with --print and the requested model — matches the spawn auth path, no API key required", async () => {
      fakeProbeSpawn({ exitCode: 0, stdout: "ok\n" });

      const result = await adapter.probe("anthropic/claude-sonnet-4-6", {
        provider: "anthropic",
        secrets: {},
      });

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [cmd, args] = mockSpawn.mock.calls[0];
      expect(cmd).toBe("claude");
      expect(args).toContain("--print");
      const modelIdx = (args as string[]).indexOf("--model");
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect((args as string[])[modelIdx + 1]).toBe("claude-sonnet-4-6");
      expect(result).toMatchObject({ healthy: true, status: "healthy" });
    });

    it("returns healthy on exit 0 even when secrets is empty", async () => {
      fakeProbeSpawn({ exitCode: 0, stdout: "ok\n" });

      const result = await adapter.probe("anthropic/claude-opus-4-7", {
        provider: "anthropic",
        secrets: {},
      });

      expect(result.healthy).toBe(true);
      expect(result.failureClass).toBeNull();
    });

    it("classifies an auth-style stderr as failureClass=auth", async () => {
      fakeProbeSpawn({ exitCode: 1, stderr: "Invalid API key. Please log in with `claude login`." });

      const result = await adapter.probe("anthropic/claude-sonnet-4-6", {
        provider: "anthropic",
        secrets: {},
      });

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        healthy: false,
        status: "unhealthy",
        failureClass: "auth",
      });
      // The new probe surfaces the CLI stderr, not the missing-key short-circuit
      expect(result.reason.code).not.toBe("missing_anthropic_api_key");
    });

    it("classifies SIGTERM (exit 143) as a probe timeout", async () => {
      fakeProbeSpawn({ exitCode: 143 });

      const result = await adapter.probe("anthropic/claude-sonnet-4-6", {
        provider: "anthropic",
        secrets: {},
      });

      expect(result).toMatchObject({
        healthy: false,
        failureClass: "timeout",
      });
    });

    it("strips ANTHROPIC_API_KEY from inherited env so the CLI uses its own OAuth", async () => {
      const prev = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "sk-from-dispatcher-env";
      try {
        fakeProbeSpawn({ exitCode: 0, stdout: "ok\n" });
        await adapter.probe("anthropic/claude-sonnet-4-6", {
          provider: "anthropic",
          secrets: {},
        });
        const env = mockSpawn.mock.calls[0][2].env as Record<string, string | undefined>;
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
        expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      } finally {
        if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prev;
      }
    });

    it("re-applies credential.secrets after the env strip so per-hive overrides win", async () => {
      fakeProbeSpawn({ exitCode: 0, stdout: "ok\n" });

      await adapter.probe("anthropic/claude-sonnet-4-6", {
        provider: "anthropic",
        secrets: { ANTHROPIC_API_KEY: "sk-hive-override" },
      });

      const env = mockSpawn.mock.calls[0][2].env as Record<string, string | undefined>;
      expect(env.ANTHROPIC_API_KEY).toBe("sk-hive-override");
    });

    it("classifies a spawn ENOENT (claude CLI missing) as unavailable", async () => {
      const err = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      fakeProbeSpawn({ exitCode: 0, error: err });

      const result = await adapter.probe("anthropic/claude-sonnet-4-6", {
        provider: "anthropic",
        secrets: {},
      });

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(result.healthy).toBe(false);
      expect(result.reason.code).not.toBe("missing_anthropic_api_key");
    });
  });
});
