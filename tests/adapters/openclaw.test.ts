import { describe, it, expect } from "vitest";
import { generateFiles, buildCommand } from "@/adapters/openclaw";
import type { SessionContext, RoleContext, MemoryContext } from "@/adapters/types";
import type { ClaimedTask } from "@/dispatcher/types";

const mockTask: ClaimedTask = {
  id: "test-id",
  hiveId: "biz-id",
  assignedTo: "dev-agent",
  createdBy: "owner",
  status: "active",
  priority: 5,
  title: "Test task",
  brief: "Do the thing",
  parentTaskId: null,
  goalId: null,
  sprintNumber: null,
  qaRequired: false,
  acceptanceCriteria: "It works",
  retryCount: 0,
  doctorAttempts: 0,
  failureReason: null,
  projectId: null,
};

function makeCtx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    task: mockTask,
    roleTemplate: {
      slug: "dev-agent",
      department: "engineering",
      roleMd: "# Developer\nYou write code.",
      soulMd: "You are methodical and precise.",
      toolsMd: "# Tools\nFile system, git, npm.",
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

describe("OpenClaw adapter", () => {
  it("AGENTS.md contains task title and brief", () => {
    const { agentsMd } = generateFiles(makeCtx());
    expect(agentsMd).toContain("Test task");
    expect(agentsMd).toContain("Do the thing");
  });

  it("AGENTS.md contains memory entries", () => {
    const ctx = makeCtx({
      memoryContext: {
        roleMemory: [{ content: "Use strict TypeScript", confidence: 0.95, updatedAt: new Date() }],
        hiveMemory: [{ content: "Black Friday is peak season", category: "seasonal", confidence: 1.0 }],
        insights: [{ content: "Cache hit rate low", connectionType: "performance", confidence: 0.8 }],
        capacity: "3/200",
      },
    });
    const { agentsMd } = generateFiles(ctx);
    expect(agentsMd).toContain("Use strict TypeScript");
    expect(agentsMd).toContain("Black Friday is peak season");
    expect(agentsMd).toContain("Cache hit rate low");
    expect(agentsMd).toContain("3/200");
  });

  it("SOUL.md contains role identity", () => {
    const { soulMd } = generateFiles(makeCtx());
    expect(soulMd).toContain("# Developer");
    expect(soulMd).toContain("You are methodical and precise.");
  });

  it("TOOLS.md contains tools content", () => {
    const { toolsMd } = generateFiles(makeCtx());
    expect(toolsMd).toContain("# Tools");
    expect(toolsMd).toContain("File system, git, npm.");
  });

  it("AGENTS.md includes skills", () => {
    const ctx = makeCtx({
      skills: ["## Skill: Write Tests\nUse vitest for all unit tests."],
    });
    const { agentsMd } = generateFiles(ctx);
    expect(agentsMd).toContain("Skill: Write Tests");
    expect(agentsMd).toContain("Use vitest for all unit tests.");
  });

  it("AGENTS.md includes standing instructions", () => {
    const ctx = makeCtx({
      standingInstructions: ["Always use Australian English spelling", "Keep responses concise"],
    });
    const { agentsMd } = generateFiles(ctx);
    expect(agentsMd).toContain("Australian English spelling");
    expect(agentsMd).toContain("Keep responses concise");
  });

  it("buildCommand returns correct args for the openclaw CLI", () => {
    // Current openclaw CLI shape: `openclaw agent --agent <id> --message <text> --json`
    // The agent id is derived from the role slug (prefixed hw-) or, for
    // goal supervisors, hw-gs-<biz>-<goalId-prefix>.
    const ctx = makeCtx({ model: "anthropic/claude-sonnet-4-6" });
    const args = buildCommand(ctx, "hello agent");

    expect(args[0]).toBe("agent");
    expect(args).toContain("--agent");
    expect(args).toContain("--message");
    expect(args).toContain("--json");

    // Agent id should be hw-<role-slug> for non-goal-supervisor roles.
    const agentIdx = args.indexOf("--agent");
    expect(args[agentIdx + 1]).toMatch(/^hw-/);

    // Message gets a "/new " prefix so openclaw treats it as a new turn.
    const messageIdx = args.indexOf("--message");
    expect(args[messageIdx + 1]).toBe("/new hello agent");
  });
});
