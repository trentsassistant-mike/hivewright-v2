import { describe, expect, it } from "vitest";
import { renderSessionPrompt } from "@/adapters/context-renderer";
import type { ClaimedTask } from "@/dispatcher/types";
import type { MemoryContext, RoleContext, SessionContext } from "@/adapters/types";

const baseTask: ClaimedTask = {
  id: "task-lean-renderer",
  hiveId: "hive-1",
  assignedTo: "dev-agent",
  createdBy: "owner",
  status: "active",
  priority: 5,
  title: "Implement lean context",
  brief: "Implement the smallest shared runtime change.",
  parentTaskId: null,
  goalId: "goal-1",
  sprintNumber: null,
  qaRequired: true,
  acceptanceCriteria: "Acceptance criteria stay visible.",
  retryCount: 0,
  doctorAttempts: 0,
  failureReason: null,
  projectId: null,
};

function makeCtx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    task: baseTask,
    roleTemplate: {
      slug: "dev-agent",
      department: "engineering",
      roleMd: "# Developer\nWrite, test, and commit code.",
      soulMd: "Be methodical.",
      toolsMd: "# Tools\nFilesystem and git.",
    } as RoleContext,
    memoryContext: {
      roleMemory: [],
      hiveMemory: [],
      insights: [],
      capacity: "0/200",
    } as MemoryContext,
    skills: [],
    standingInstructions: [],
    goalContext: "Goal: Reduce context volume\nDo not reduce verification quality.",
    projectWorkspace: "/repo",
    model: "anthropic/claude-sonnet-4-6",
    fallbackModel: null,
    credentials: {},
    contextPolicy: { mode: "lean", reason: "executor_default" },
    ...overrides,
  };
}

describe("renderSessionPrompt", () => {
  it("renders lean executor context with essentials and retrieval instructions", () => {
    const hiddenMemoryTail = "RAW_MEMORY_SENTINEL_SHOULD_NOT_APPEAR";
    const ctx = makeCtx({
      memoryContext: {
        roleMemory: [
          {
            content: `Use TypeScript strict mode. ${"x".repeat(900)} ${hiddenMemoryTail}`,
            confidence: 0.98,
            updatedAt: new Date("2026-05-06T00:00:00.000Z"),
          },
        ],
        hiveMemory: [
          {
            content: "Owner-approved constraint: do not change model routing policy.",
            category: "operations",
            confidence: 1,
          },
        ],
        insights: [],
        capacity: "1488/200",
      },
      standingInstructions: [
        `Preserve QA evidence. ${"y".repeat(900)} RAW_STANDING_SENTINEL_SHOULD_NOT_APPEAR`,
      ],
    });

    const prompt = renderSessionPrompt(ctx);

    expect(prompt).toContain("# Task: Implement lean context");
    expect(prompt).toContain("Acceptance criteria stay visible.");
    expect(prompt).toContain("Goal: Reduce context volume");
    expect(prompt).toContain("## Retrieval And Evidence");
    expect(prompt).toContain("task logs");
    expect(prompt).toContain("work_products");
    expect(prompt).toContain("Use TypeScript strict mode");
    expect(prompt).toContain("Owner-approved constraint");
    expect(prompt).not.toContain(hiddenMemoryTail);
    expect(prompt).not.toContain("RAW_STANDING_SENTINEL_SHOULD_NOT_APPEAR");
  });

  it("compacts bulky historical prompt sections instead of replaying raw logs", () => {
    const rawLogTail = "RAW_TOOL_LOG_TAIL_SHOULD_NOT_APPEAR";
    const ctx = makeCtx({
      task: {
        ...baseTask,
        brief: [
          "Current task: verify and fix the runtime path.",
          "",
          "## Prior Session Context",
          `${Array.from({ length: 80 }, (_, i) => `tool-output-${i}: ${"z".repeat(90)}`).join("\n")}`,
          rawLogTail,
        ].join("\n"),
      },
    });

    const prompt = renderSessionPrompt(ctx);

    expect(prompt).toContain("Current task: verify and fix the runtime path.");
    expect(prompt).toContain("## Prior Session Context");
    expect(prompt).toContain("[lean-context]");
    expect(prompt).not.toContain(rawLogTail);
  });

  it("can still render full context for non-lean policies", () => {
    const rawMemoryTail = "FULL_MEMORY_SENTINEL";
    const ctx = makeCtx({
      contextPolicy: { mode: "full", reason: "non_executor" },
      memoryContext: {
        roleMemory: [{
          content: `Full context keeps raw memory. ${rawMemoryTail}`,
          confidence: 0.9,
          updatedAt: new Date("2026-05-06T00:00:00.000Z"),
        }],
        hiveMemory: [],
        insights: [],
        capacity: "1/200",
      },
    });

    const prompt = renderSessionPrompt(ctx);

    expect(prompt).toContain(rawMemoryTail);
    expect(prompt).not.toContain("## Retrieval And Evidence");
  });

  it("renders git-backed project discipline only when the session is explicitly git-backed", () => {
    const plainPrompt = renderSessionPrompt(makeCtx({ gitBackedProject: false }));
    const repoPrompt = renderSessionPrompt(makeCtx({ gitBackedProject: true }));

    expect(plainPrompt).not.toContain("## Git-Backed Project Discipline");
    expect(plainPrompt).not.toContain("Include the commit SHA");
    expect(repoPrompt).toContain("## Git-Backed Project Discipline");
    expect(repoPrompt).toContain("project marked `git_repo=true`");
    expect(repoPrompt).toContain("Include the commit SHA");
  });
});
