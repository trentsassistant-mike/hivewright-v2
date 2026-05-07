import { describe, expect, it } from "vitest";
import type { ModelRoutingTaskContext } from "./task-classifier";
import { classifyModelRoutingTask } from "./task-classifier";

describe("classifyModelRoutingTask", () => {
  it("classifies implementation tasks as coding", () => {
    const classification = classifyModelRoutingTask({
      roleSlug: "backend-engineer",
      roleType: "executor",
      taskTitle: "Implement task classifier",
      taskBrief: "Add TypeScript tests for the routing behavior.",
    });

    expect(classification.profile).toBe("coding");
    expect(classification.confidence).toBe("high");
    expect(classification.signals).toContain("task mentions implementation/code/test work");
  });

  it("classifies copy and document tasks as writing", () => {
    const classification = classifyModelRoutingTask({
      roleSlug: "communications",
      roleType: "executor",
      taskTitle: "Draft launch copy",
      taskBrief: "Write the customer-facing document.",
    });

    expect(classification.profile).toBe("writing");
    expect(classification.confidence).toBe("high");
  });

  it("classifies connector and tool tasks as tool agents requiring tools", () => {
    const classification = classifyModelRoutingTask({
      roleSlug: "integration-engineer",
      roleType: "executor",
      taskTitle: "Sync connector webhook",
      taskBrief: "Use the MCP tool API to reconcile events.",
    });

    expect(classification.profile).toBe("tool_agent");
    expect(classification.confidence).toBe("high");
    expect(classification.constraints.requiresTools).toBe(true);
  });

  it("uses a medium-confidence analysis role default for generic goal supervisors", () => {
    const classification = classifyModelRoutingTask({
      roleSlug: "goal-supervisor",
      roleType: "system",
      taskTitle: "Review current task state",
    });

    expect(classification.profile).toBe("analysis");
    expect(classification.confidence).toBe("medium");
    expect(classification.signals).toContain("role default profile: analysis");
  });

  it("routes retries to fallback_strong", () => {
    const classification = classifyModelRoutingTask({
      roleSlug: "writer",
      roleType: "executor",
      taskTitle: "Draft update",
      retryCount: 1,
    });

    expect(classification.profile).toBe("fallback_strong");
    expect(classification.confidence).toBe("high");
    expect(classification.signals).toContain("retry");
  });

  it("routes high-risk domain tasks to domain_sensitive", () => {
    const classification = classifyModelRoutingTask({
      roleSlug: "analyst",
      roleType: "executor",
      taskTitle: "Review compliance summary",
      taskBrief: "Check medical and finance implications.",
    });

    expect(classification.profile).toBe("domain_sensitive");
    expect(classification.confidence).toBe("high");
  });

  it("uses a coding role default for generic dev-agent tasks", () => {
    const classification = classifyModelRoutingTask({
      roleSlug: "dev-agent",
      roleType: "executor",
      taskTitle: "Add dashboard filter",
    });

    expect(classification.profile).toBe("coding");
    expect(classification.confidence).toBe("medium");
  });

  it("does not classify operational health checks as high-risk domain work", () => {
    const classification = classifyModelRoutingTask({
      roleSlug: "backend-engineer",
      roleType: "executor",
      taskTitle: "Fix health check endpoint",
    });

    expect(classification.profile).toBe("coding");
    expect(classification.constraints.highRiskDomain).toBe(false);
  });

  it("classifies API documentation drafts as writing", () => {
    const classification = classifyModelRoutingTask({
      roleSlug: "content-writer",
      roleType: "executor",
      taskTitle: "Draft API documentation",
    });

    expect(classification.profile).toBe("writing");
  });

  it("classifies document summaries as summarization", () => {
    const classification = classifyModelRoutingTask({
      roleSlug: "content-writer",
      roleType: "executor",
      taskTitle: "Summarize this document",
    });

    expect(classification.profile).toBe("summarization");
  });

  it("classifies daily sync summaries as summarization", () => {
    const classification = classifyModelRoutingTask({
      roleSlug: "goal-supervisor",
      roleType: "system",
      taskTitle: "Daily sync summary",
    });

    expect(classification.profile).toBe("summarization");
  });

  it("uses an analysis role default for generic system health auditor tasks", () => {
    const classification = classifyModelRoutingTask({
      roleSlug: "system-health-auditor",
      roleType: "system",
      taskTitle: "Review current status",
    });

    expect(classification.profile).toBe("analysis");
    expect(classification.confidence).toBe("medium");
    expect(classification.constraints.highRiskDomain).toBe(false);
  });

  it.each([
    ["hive-development-agent", "coding"],
    ["code-review-agent", "analysis"],
    ["research-analyst", "research"],
    ["content-writer", "writing"],
  ] as const)("uses %s role default for neutral tasks", (roleSlug, expectedProfile) => {
    const classification = classifyModelRoutingTask({
      roleSlug,
      roleType: "executor",
      taskTitle: "Review current status",
    });

    expect(classification.profile).toBe(expectedProfile);
    expect(classification.confidence).toBe("medium");
    expect(classification.signals).toContain(`role default profile: ${expectedProfile}`);
  });

  it("includes nullable role type and role signals in searchable classification text", () => {
    const researchInput: ModelRoutingTaskContext = {
      roleSlug: "source-investigator",
      roleType: null,
      taskTitle: "Review current status",
    };
    const researchTypeInput: ModelRoutingTaskContext = {
      roleSlug: "generalist",
      roleType: "research",
      taskTitle: "Review current status",
    };

    expect(classifyModelRoutingTask(researchInput).profile).toBe("research");
    expect(classifyModelRoutingTask(researchInput).confidence).toBe("high");
    expect(classifyModelRoutingTask(researchTypeInput).profile).toBe("research");
    expect(classifyModelRoutingTask(researchTypeInput).confidence).toBe("high");
  });
});
