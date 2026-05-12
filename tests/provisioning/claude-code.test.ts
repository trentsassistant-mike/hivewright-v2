import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeProvisioner } from "../../src/provisioning/claude-code";

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawn: mockSpawn,
}));

function mockVersionCheck({
  code = 0,
  stdout = "",
  stderr = "",
  error = null,
}: {
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: Error | null;
}) {
  mockSpawn.mockImplementation(() => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) proc.stdout.emit("data", Buffer.from(stdout, "utf8"));
      if (stderr) proc.stderr.emit("data", Buffer.from(stderr, "utf8"));
      if (error) {
        proc.emit("error", error);
        return;
      }
      proc.emit("close", code);
    });
    return proc;
  });
}

describe("ClaudeCodeProvisioner", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("reports satisfied when the claude CLI is at the required minimum version", async () => {
    mockVersionCheck({ stdout: "2.1.138 (Claude Code)\n" });

    const p = new ClaudeCodeProvisioner();
    const status = await p.check({ slug: "dev-agent", recommendedModel: "claude-sonnet-4-6" });

    expect(status).toEqual({ satisfied: true, fixable: false });
    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      ["--version"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 }),
    );
  });

  it("fails when the installed claude CLI is older than 2.1.138", async () => {
    mockVersionCheck({ stdout: "2.1.129 (Claude Code)\n" });

    const p = new ClaudeCodeProvisioner();
    const status = await p.check({ slug: "dev-agent", recommendedModel: "claude-sonnet-4-6" });

    expect(status.satisfied).toBe(false);
    expect(status.fixable).toBe(false);
    expect(status.reason).toContain("2.1.138");
    expect(status.reason).toContain("2.1.129");
  });

  it("fails clearly when the claude CLI is not reachable on PATH", async () => {
    mockVersionCheck({ error: new Error("spawn claude ENOENT") });

    const p = new ClaudeCodeProvisioner();
    const status = await p.check({ slug: "dev-agent", recommendedModel: "claude-sonnet-4-6" });

    expect(status).toMatchObject({
      satisfied: false,
      fixable: false,
    });
    expect(status.reason).toContain("claude CLI not found on PATH");
  });

  it("provision yields the checked status as the final event", async () => {
    mockVersionCheck({ stdout: "2.1.138 (Claude Code)\n" });

    const p = new ClaudeCodeProvisioner();
    const events = [];
    for await (const ev of p.provision({ slug: "dev-agent", recommendedModel: "claude-sonnet-4-6" })) {
      events.push(ev);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ phase: "done", status: { satisfied: true, fixable: false } });
  });
});
