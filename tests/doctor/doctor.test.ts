import { describe, it, expect, beforeEach } from "vitest";
import { createDoctorTask, applyDoctorDiagnosis } from "@/doctor";
import type { DoctorDiagnosis } from "@/doctor/types";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('doctor-test-biz', 'Doctor Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('doctor-test-role', 'DT Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('doctor-test-role2', 'DT Role 2', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('doctor', 'Doctor', 'system', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("applyDoctorDiagnosis", () => {
  it("rewrites a task brief", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'doctor-test-role', 'owner', 'doctor-test-rewrite', 'Bad brief', 'failed')
      RETURNING *
    `;

    const diagnosis: DoctorDiagnosis = {
      action: "rewrite_brief",
      details: "Brief was ambiguous",
      newBrief: "Clear brief with specific instructions",
    };

    await applyDoctorDiagnosis(sql, task.id, diagnosis);

    const [updated] = await sql`SELECT status, brief, doctor_attempts FROM tasks WHERE id = ${task.id}`;
    expect(updated.status).toBe("pending");
    expect(updated.brief).toBe("Clear brief with specific instructions");
    expect(updated.doctor_attempts).toBe(1);

    const [event] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata
      FROM agent_audit_events
      WHERE task_id = ${task.id}
        AND event_type = 'task.lifecycle_transition'
    `;
    expect(event.metadata).toMatchObject({
      taskId: task.id,
      hiveId: bizId,
      previousStatus: "failed",
      nextStatus: "pending",
      source: "doctor.applyDiagnosis.rewriteBrief",
      reason: "Brief was ambiguous",
    });
  });

  it("reassigns to a different role", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'doctor-test-role', 'owner', 'doctor-test-reassign', 'Brief', 'failed')
      RETURNING *
    `;

    const diagnosis: DoctorDiagnosis = {
      action: "reassign",
      details: "Wrong role for this task",
      newRole: "doctor-test-role2",
    };

    await applyDoctorDiagnosis(sql, task.id, diagnosis);

    const [updated] = await sql`SELECT status, assigned_to, doctor_attempts FROM tasks WHERE id = ${task.id}`;
    expect(updated.status).toBe("pending");
    expect(updated.assigned_to).toBe("doctor-test-role2");
    expect(updated.doctor_attempts).toBe(1);
  });

  it("splits a task into subtasks", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'doctor-test-role', 'owner', 'doctor-test-split', 'Big task', 'failed')
      RETURNING *
    `;

    const diagnosis: DoctorDiagnosis = {
      action: "split_task",
      details: "Task too complex",
      subTasks: [
        { title: "doctor-test-sub1", brief: "Part 1", assignedTo: "doctor-test-role" },
        { title: "doctor-test-sub2", brief: "Part 2", assignedTo: "doctor-test-role2" },
      ],
    };

    await applyDoctorDiagnosis(sql, task.id, diagnosis);

    const [original] = await sql`SELECT status FROM tasks WHERE id = ${task.id}`;
    expect(original.status).toBe("cancelled");

    const subs = await sql`SELECT * FROM tasks WHERE parent_task_id = ${task.id} ORDER BY title`;
    expect(subs.length).toBe(2);
    expect(subs[0].title).toBe("doctor-test-sub1");
    expect(subs[1].title).toBe("doctor-test-sub2");

    const [event] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata
      FROM agent_audit_events
      WHERE task_id = ${task.id}
        AND event_type = 'task.lifecycle_transition'
    `;
    expect(event.metadata).toMatchObject({
      taskId: task.id,
      hiveId: bizId,
      previousStatus: "failed",
      nextStatus: "cancelled",
      source: "doctor.applyDiagnosis.splitTask",
      reason: "Task too complex",
    });
  });

  it("parks instead of splitting when replacement subtask budget would be exceeded", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'doctor-test-role', 'owner', 'doctor-test-split-budget', 'Big task', 'failed')
      RETURNING *
    `;

    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id)
      VALUES
        (${bizId}, 'doctor-test-role', 'doctor', 'existing recovery one', 'Part 1', 'pending', ${task.id}),
        (${bizId}, 'doctor-test-role2', 'doctor', 'existing recovery two', 'Part 2', 'pending', ${task.id})
    `;

    await applyDoctorDiagnosis(sql, task.id, {
      action: "split_task",
      details: "Still too complex",
      subTasks: [
        { title: "new recovery one", brief: "Part 3", assignedTo: "doctor-test-role" },
        { title: "new recovery two", brief: "Part 4", assignedTo: "doctor-test-role2" },
      ],
    });

    const allChildren = await sql`
      SELECT title
      FROM tasks
      WHERE parent_task_id = ${task.id}
      ORDER BY title
    `;
    expect(allChildren.map((row) => row.title)).toEqual([
      "existing recovery one",
      "existing recovery two",
    ]);

    const [updated] = await sql`SELECT status, failure_reason FROM tasks WHERE id = ${task.id}`;
    expect(updated.status).toBe("unresolvable");
    expect(updated.failure_reason).toContain("Recovery budget exhausted");
    expect(updated.failure_reason).toContain("replacement tasks");
  });

  it("copies parent workspace metadata to split subtasks", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'doctor-test-role', 'owner', 'doctor-test-split-workspace', 'Big task', 'failed')
      RETURNING *
    `;
    await sql`
      INSERT INTO task_workspaces (
        task_id, base_workspace_path, worktree_path, branch_name,
        isolation_status, isolation_active, reused
      )
      VALUES (
        ${task.id}, '/repo/base', '/repo/base/.claude/worktrees/parent',
        'hw/task/parent-doctor-test-role', 'active', true, false
      )
    `;

    await applyDoctorDiagnosis(sql, task.id, {
      action: "split_task",
      details: "Task too complex",
      subTasks: [
        { title: "doctor-test-sub-workspace", brief: "Part 1", assignedTo: "doctor-test-role" },
      ],
    });

    const [workspace] = await sql`
      SELECT tw.worktree_path, tw.branch_name, tw.reused
      FROM task_workspaces tw
      JOIN tasks t ON t.id = tw.task_id
      WHERE t.parent_task_id = ${task.id}
    `;
    expect(workspace.worktree_path).toBe("/repo/base/.claude/worktrees/parent");
    expect(workspace.branch_name).toBe("hw/task/parent-doctor-test-role");
    expect(workspace.reused).toBe(true);
  });

  it("copies parent workspace metadata to fix_environment tasks without changing doctor-hook shape", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'doctor-test-role', 'owner', 'doctor-test-env-workspace', 'Needs env', 'failed')
      RETURNING *
    `;
    await sql`
      INSERT INTO task_workspaces (
        task_id, base_workspace_path, worktree_path, branch_name,
        isolation_status, isolation_active, reused
      )
      VALUES (
        ${task.id}, '/repo/base', '/repo/base/.claude/worktrees/env-parent',
        'hw/task/env-parent', 'active', true, false
      )
    `;

    await applyDoctorDiagnosis(sql, task.id, {
      action: "fix_environment",
      details: "Install missing SDK.",
    });

    const [envFix] = await sql`
      SELECT t.parent_task_id, tw.worktree_path, tw.reused
      FROM tasks t
      JOIN task_workspaces tw ON tw.task_id = t.id
      WHERE t.title = ${"Fix environment for: " + task.id}
    `;
    expect(envFix.parent_task_id).toBeNull();
    expect(envFix.worktree_path).toBe("/repo/base/.claude/worktrees/env-parent");
    expect(envFix.reused).toBe(true);
  });

  it("creates a Tier 3 decision on escalation", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'doctor-test-role', 'owner', 'doctor-test-escalate', 'Brief', 'failed')
      RETURNING *
    `;

    const diagnosis: DoctorDiagnosis = {
      action: "escalate",
      details: "Cannot resolve automatically",
      decisionTitle: "doctor-test-decision",
      decisionContext: "Task failed repeatedly, needs owner input",
    };

    await applyDoctorDiagnosis(sql, task.id, diagnosis);

    const [updated] = await sql`SELECT status FROM tasks WHERE id = ${task.id}`;
    expect(updated.status).toBe("unresolvable");

    const decisions = await sql`SELECT * FROM decisions WHERE title = 'doctor-test-decision'`;
    expect(decisions.length).toBe(1);
    expect(decisions[0].priority).toBe("urgent");
  });

  it("parks instead of creating another EA decision when a recovery decision is already open", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'doctor-test-role', 'owner', 'doctor-test-escalate-budget', 'Brief', 'failed')
      RETURNING *
    `;

    await sql`
      INSERT INTO decisions (hive_id, task_id, title, context, recommendation, priority, status, kind)
      VALUES (
        ${bizId},
        ${task.id},
        'Existing recovery decision',
        'Already waiting for review.',
        'Do not create more recovery work.',
        'urgent',
        'ea_review',
        'system_error'
      )
    `;

    await applyDoctorDiagnosis(sql, task.id, {
      action: "escalate",
      details: "Still needs owner input",
      decisionTitle: "Second decision should not be created",
      decisionContext: "This would duplicate the open decision.",
    });

    const decisions = await sql`
      SELECT title
      FROM decisions
      WHERE task_id = ${task.id}
      ORDER BY created_at
    `;
    expect(decisions.map((row) => row.title)).toEqual(["Existing recovery decision"]);

    const [updated] = await sql`SELECT status, failure_reason FROM tasks WHERE id = ${task.id}`;
    expect(updated.status).toBe("unresolvable");
    expect(updated.failure_reason).toContain("Recovery budget exhausted");
    expect(updated.failure_reason).toContain("open recovery decisions");
  });

  it("preserves project context via task_id when escalating a project-scoped task", async () => {
    // Regression: previously the escalate path dropped the originating
    // task linkage, so EA / dispatcher / dashboard could not resolve the
    // project workspace from the resulting decision. Decisions has no
    // project_id column, so we must round-trip through task_id.
    const [project] = await sql`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES (${bizId}, 'doctor-test-escalate-project', 'Doctor Escalate Project', '/tmp/doctor-test/escalate')
      RETURNING id
    `;
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, description, project_id)
      VALUES (${bizId}, 'Goal for escalate', 'desc', ${project.id})
      RETURNING id
    `;
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, project_id, goal_id)
      VALUES (${bizId}, 'doctor-test-role', 'owner', 'doctor-test-escalate-scoped', 'Brief', 'failed', ${project.id}, ${goal.id})
      RETURNING *
    `;

    const diagnosis: DoctorDiagnosis = {
      action: "escalate",
      details: "Cannot resolve automatically",
      decisionTitle: "doctor-test-decision-scoped",
      decisionContext: "Owner input needed",
    };

    await applyDoctorDiagnosis(sql, task.id, diagnosis);

    const [decision] = await sql<{
      id: string;
      hive_id: string;
      goal_id: string | null;
      task_id: string | null;
    }[]>`
      SELECT id, hive_id, goal_id, task_id
      FROM decisions WHERE title = 'doctor-test-decision-scoped'
    `;
    expect(decision.task_id).toBe(task.id);
    expect(decision.goal_id).toBe(goal.id);
    expect(decision.hive_id).toBe(bizId);

    // The decision must be traceable back to the project-scoped task so
    // downstream surfaces (EA, dispatcher, adapters, dashboard) can
    // resolve the project workspace through the task row.
    const [scoped] = await sql<{ project_id: string | null }[]>`
      SELECT t.project_id
      FROM decisions d JOIN tasks t ON t.id = d.task_id
      WHERE d.id = ${decision.id}
    `;
    expect(scoped.project_id).toBe(project.id);
  });
});

describe("createDoctorTask", () => {
  it("creates a doctor task for a failed task", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${bizId}, 'doctor-test-role', 'owner', 'doctor-test-source', 'Brief', 'failed', 'API error')
      RETURNING *
    `;

    const doctorTask = await createDoctorTask(sql, task.id);
    expect(doctorTask).not.toBeNull();
    expect(doctorTask!.assigned_to).toBe("doctor");
    expect(doctorTask!.title).toContain("doctor-test-source");
  });

  it("copies parent workspace metadata to the created doctor task", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${bizId}, 'doctor-test-role', 'owner', 'doctor-test-source-workspace', 'Brief', 'failed', 'API error')
      RETURNING *
    `;
    await sql`
      INSERT INTO task_workspaces (
        task_id, base_workspace_path, worktree_path, branch_name,
        isolation_status, isolation_active, reused
      )
      VALUES (
        ${task.id}, '/repo/base', '/repo/base/.claude/worktrees/source',
        'hw/task/source-doctor-test-role', 'active', true, false
      )
    `;

    const doctorTask = await createDoctorTask(sql, task.id);
    const [workspace] = await sql`
      SELECT worktree_path, branch_name, reused
      FROM task_workspaces
      WHERE task_id = ${doctorTask!.id}
    `;
    expect(workspace.worktree_path).toBe("/repo/base/.claude/worktrees/source");
    expect(workspace.branch_name).toBe("hw/task/source-doctor-test-role");
    expect(workspace.reused).toBe(true);
  });

  it("includes codex empty-output diagnostics in doctor brief when task_logs diagnostic exists", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${bizId}, 'doctor-test-role', 'owner', 'doctor-test-diagnostic-source', 'Brief', 'failed', 'Codex exited code 1: codex reported error')
      RETURNING *
    `;
    await sql`
      INSERT INTO task_logs (task_id, type, chunk)
      VALUES (${task.id}, 'diagnostic', ${JSON.stringify({
        kind: "codex_empty_output",
        schemaVersion: 1,
        codexEmptyOutput: true,
        rolloutSignaturePresent: true,
        exitCode: 1,
        effectiveAdapter: "codex",
        adapterOverride: "codex",
        modelSlug: "openai-codex/gpt-5.5",
        modelProviderMismatchDetected: false,
        cwd: "/workspace/hivewrightv2",
        stderrTail: "failed to record rollout items",
        truncated: false,
      })})
    `;

    const doctorTask = await createDoctorTask(sql, task.id);

    expect(doctorTask!.brief).toContain("### Runtime Diagnostics");
    expect(doctorTask!.brief).toContain("- codexEmptyOutput: true");
    expect(doctorTask!.brief).toContain("- rolloutSignaturePresent: true");
    expect(doctorTask!.brief).toContain("- exitCode: 1");
    expect(doctorTask!.brief).toContain("- effectiveAdapter: codex");
    expect(doctorTask!.brief).toContain("- adapterOverride: codex");
    expect(doctorTask!.brief).toContain("- modelSlug: openai-codex/gpt-5.5");
    expect(doctorTask!.brief).toContain("- modelProviderMismatchDetected: false");
    expect(doctorTask!.brief).toContain("failed to record rollout items");
  });

  it("omits runtime diagnostics section when no diagnostic row exists", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${bizId}, 'doctor-test-role', 'owner', 'doctor-test-no-diagnostic-source', 'Brief', 'failed', 'API error')
      RETURNING *
    `;

    const doctorTask = await createDoctorTask(sql, task.id);

    expect(doctorTask!.brief).not.toContain("### Runtime Diagnostics");
  });
});
