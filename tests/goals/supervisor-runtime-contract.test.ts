import { describe, it, expect } from "vitest";
import { buildGoalSupervisorProcessEnv } from "@/goals/supervisor-env";
import { buildSupervisorToolsMd } from "@/goals/supervisor-tool-contract";

const goalId = "11111111-2222-4333-8444-555555555555";
const hiveId = "22222222-3333-4444-9555-666666666666";

describe("goal supervisor runtime contract", () => {
  it("scrubs inherited task and hive scope while setting the supervisor session", () => {
    const env = buildGoalSupervisorProcessEnv(
      {
        INTERNAL_SERVICE_TOKEN: "token",
        HIVEWRIGHT_TASK_ID: "wrong-parent-task",
        HIVEWRIGHT_HIVE_ID: "wrong-parent-hive",
        PATH: "/usr/bin",
      },
      "/tmp/hivewright/goal-session",
    );

    expect(env.INTERNAL_SERVICE_TOKEN).toBe("token");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HIVEWRIGHT_SUPERVISOR_SESSION).toBe("/tmp/hivewright/goal-session");
    expect(env.HIVEWRIGHT_TASK_ID).toBeUndefined();
    expect(env.HIVEWRIGHT_HIVE_ID).toBeUndefined();
  });

  it("tells supervisors to send X-Supervisor-Session on task, plan, and complete writes", () => {
    const tools = buildSupervisorToolsMd(
      { hive_id: hiveId, project_id: null },
      goalId,
    );

    expect(tools).toContain('X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION');
    expect(section(tools, "## Create Task")).toContain('X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION');
    expect(section(tools, "## Create / Update Goal Plan")).toContain('X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION');
    expect(section(tools, "## Mark Goal Achieved")).toContain('X-Supervisor-Session: $HIVEWRIGHT_SUPERVISOR_SESSION');
    expect(tools).not.toContain("X-HiveWright-Task-Id:");
    expect(tools).not.toContain("HIVEWRIGHT_TASK_ID");
  });

  it("requires completion evidence and learning gate in the Mark Goal Achieved contract", () => {
    const tools = buildSupervisorToolsMd(
      { hive_id: hiveId, project_id: null },
      goalId,
    );
    const markAchieved = section(tools, "## Mark Goal Achieved");

    expect(markAchieved).toMatch(/non-empty `evidence` bundle/i);
    expect(markAchieved).toMatch(/Do not mark achieved without evidence/i);
    expect(markAchieved).toMatch(/must also include `learningGate`/i);
    expect(markAchieved).toMatch(/owner approval before it becomes mandatory/i);
    expect(markAchieved).toContain('"evidence":[{"type":"artifact"');
    expect(markAchieved).toContain('"learningGate":{"category":"nothing"');
  });

  it("keeps pipeline routing selective instead of pipeline-first in generated TOOLS.md", () => {
    const tools = buildSupervisorToolsMd(
      { hive_id: hiveId, project_id: null },
      goalId,
    );

    const listPipelines = section(tools, "## List Pipeline Templates");
    expect(listPipelines).toContain(`/api/pipelines?hiveId=${hiveId}`);
    expect(listPipelines).toMatch(/process-bound/i);
    expect(listPipelines).toMatch(/mandatory owner process|owner-approved/i);
    expect(listPipelines).toMatch(/not.*default|not.*blanket/i);
    expect(listPipelines).not.toMatch(/Call this before creating normal execution tasks/i);

    expect(section(tools, "## Start Pipeline From Work Item Or Goal Context")).toContain(`"goalId":"${goalId}"`);
    expect(section(tools, "## Start Pipeline From Work Item Or Goal Context")).toContain('"selectionRationale":"<why this template fits>"');
    const workflow = section(tools, "## Expected workflow for this run");
    expect(workflow).toMatch(/PUT \/api\/goals\/.+documents\/plan[\s\S]*before/i);
    expect(workflow).toMatch(/inspect active templates as part of the policy\/process check/i);
    expect(workflow).toMatch(/materially fits because it is mandatory, owner-approved, or order\/evidence\/approval matters/i);
    expect(workflow).toMatch(/If no template fits[\s\S]*outcome-led/i);
    expect(workflow).toContain("do not create parallel manual sprint tasks");
    expect(tools).not.toContain("Pipeline-first route selection");
  });

  it("does not imply repository execution when a goal has no explicit project", () => {
    const tools = buildSupervisorToolsMd(
      { hive_id: hiveId, project_id: null },
      goalId,
    );

    expect(tools).toContain("not associated with an explicit project");
    expect(tools).toContain("Do not tell agents to create git branches, worktrees, or commits");
    expect(tools).not.toContain("so code tasks run in the correct repository");
  });

  it("distinguishes git-backed projects from non-git projects", () => {
    const nonGitTools = buildSupervisorToolsMd(
      { hive_id: hiveId, project_id: "project-plain", project_git_repo: false },
      goalId,
    );
    const gitTools = buildSupervisorToolsMd(
      { hive_id: hiveId, project_id: "project-repo", project_git_repo: true },
      goalId,
    );

    expect(nonGitTools).toContain("This project is not marked git-backed");
    expect(nonGitTools).toContain("do not tell agents to create git branches, worktrees, or commits");
    expect(gitTools).toContain("git-backed project project-repo");
    expect(gitTools).toContain("Repository branch/commit discipline applies to code-changing tasks");
  });
});

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = markdown.indexOf("\n## ", start + heading.length);
  return next === -1 ? markdown.slice(start) : markdown.slice(start, next);
}
