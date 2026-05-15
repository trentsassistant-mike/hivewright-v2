import { describe, it, expect, beforeEach } from "vitest";
import { claimNextTask, completeTask, releaseTask } from "@/dispatcher/task-claimer";
import { startPipelineRun } from "@/pipelines/service";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('claimer-test-biz', 'Claimer Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('claimer-test-role', 'CT Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("claimNextTask", () => {
  it("does not claim pending work for goals paused by budget", async () => {
    const [goal] = await sql`
      INSERT INTO goals (
        hive_id,
        title,
        status,
        budget_cents,
        spent_cents,
        budget_state,
        budget_enforced_at,
        budget_enforcement_reason
      )
      VALUES (
        ${bizId},
        'paused-budget-goal',
        'paused',
        1000,
        1000,
        'paused',
        NOW(),
        'Paused by budget'
      )
      RETURNING *
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-budget-paused', 'Brief', ${goal.id})
    `;

    const task = await claimNextTask(sql, process.pid);
    expect(task).toBeNull();
  });

  it("pauses and skips pending work when recorded goal spend is already at budget cap", async () => {
    const [goal] = await sql`
      INSERT INTO goals (
        hive_id,
        title,
        status,
        budget_cents,
        spent_cents,
        budget_state
      )
      VALUES (
        ${bizId},
        'stale-active-over-budget-goal',
        'active',
        1000,
        1000,
        'ok'
      )
      RETURNING *
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-budget-over-cap', 'Brief', ${goal.id})
    `;

    const task = await claimNextTask(sql, process.pid);
    expect(task).toBeNull();

    const [updatedGoal] = await sql`
      SELECT status, budget_state, budget_enforced_at, budget_enforcement_reason
      FROM goals
      WHERE id = ${goal.id}
    `;
    expect(updatedGoal.status).toBe("paused");
    expect(updatedGoal.budget_state).toBe("paused");
    expect(updatedGoal.budget_enforced_at).not.toBeNull();
    expect(updatedGoal.budget_enforcement_reason).toBe("Paused by budget");
  });

  it("does not claim pending work when the hive is creation-paused", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-hive-paused', 'Brief')
    `;
    await sql`
      INSERT INTO hive_runtime_locks (hive_id, creation_paused, reason, paused_by)
      VALUES (${bizId}, true, 'Paused by AI spend budget breach', 'system:ai-budget')
    `;

    const task = await claimNextTask(sql, process.pid);
    expect(task).toBeNull();
  });

  it("claims a pending task atomically", async () => {
    // Insert with future retry_after so the live dispatcher skips it
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, priority, retry_after)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-1', 'Do it', 5, NOW() + INTERVAL '1 hour')
    `;
    // Clear retry_after and immediately claim — dispatcher won't be notified of the update
    await sql`UPDATE tasks SET retry_after = NULL WHERE title = 'claimer-test-1' AND status = 'pending'`;

    const task = await claimNextTask(sql, process.pid);
    expect(task).not.toBeNull();
    expect(task!.title).toBe("claimer-test-1");
    expect(task!.status).toBe("active");
  });

  it("returns null when no pending tasks", async () => {
    // No test tasks inserted, so only stray tasks from the dispatcher could be pending.
    // Insert and immediately claim a canary to flush the queue state, then verify null.
    const task = await claimNextTask(sql, process.pid);
    // If dispatcher left a stray pending task, we might get it — that's OK,
    // re-check after clearing to verify the "no pending" path:
    if (task) {
      await sql`UPDATE tasks SET status = 'cancelled' WHERE id = ${task.id}`;
    }
    const task2 = await claimNextTask(sql, process.pid);
    expect(task2).toBeNull();
  });

  it("claims highest priority first (lowest number)", async () => {
    // Insert with future retry_after so the live dispatcher skips them
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, priority, retry_after)
      VALUES
        (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-low', 'Low', 10, NOW() + INTERVAL '1 hour'),
        (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-high', 'High', 1, NOW() + INTERVAL '1 hour')
    `;
    // Clear retry_after on both and immediately claim
    await sql`UPDATE tasks SET retry_after = NULL WHERE title LIKE 'claimer-test-%' AND status = 'pending'`;

    const task = await claimNextTask(sql, process.pid);
    expect(task!.title).toBe("claimer-test-high");
  });

  it("does not claim a second task for a role that already has an active task", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-busy-active', 'Brief', 'active')
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-blocked-by-busy', 'Brief')
    `;

    const task = await claimNextTask(sql, process.pid);
    if (task) {
      expect(task.title).not.toBe("claimer-test-blocked-by-busy");
    }
  });

  it("does claim a second task for a different role", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('claimer-test-role-other', 'CT Other', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-busy-active-2', 'Brief', 'active')
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${bizId}, 'claimer-test-role-other', 'owner', 'claimer-test-other-role', 'Brief')
    `;

    const task = await claimNextTask(sql, process.pid);
    expect(task?.title).toBe("claimer-test-other-role");
  });

  it("allows a second goal-supervisor task even when one is active", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type, concurrency_limit)
      VALUES ('goal-supervisor', 'Supervisor', 'system', 'claude-code', 50)
      ON CONFLICT (slug) DO UPDATE SET concurrency_limit = 50
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'goal-supervisor', 'dispatcher', 'sup-active', 'Brief', 'active')
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${bizId}, 'goal-supervisor', 'dispatcher', 'sup-pending-allowed', 'Brief')
    `;

    const task = await claimNextTask(sql, process.pid);
    expect(task?.title).toBe("sup-pending-allowed");
  });

  it("skips tasks with future retry_after", async () => {
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, retry_after)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-retry', 'Retry later', NOW() + INTERVAL '1 hour')
    `;

    const task = await claimNextTask(sql, process.pid);
    // The task has retry_after in the future, so it should be skipped.
    // If a stray non-test task gets claimed, that's OK — we just need to verify
    // our test task was NOT the one claimed.
    if (task) {
      expect(task.title).not.toBe("claimer-test-retry");
    }
  });
});

describe("releaseTask", () => {
  it("sets task back to pending with retry_after and increments retry_count", async () => {
    const [inserted] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-release', 'Brief', 'active')
      RETURNING *
    `;

    await releaseTask(sql, inserted.id, 60);

    const [updated] = await sql`SELECT status, retry_count, retry_after FROM tasks WHERE id = ${inserted.id}`;
    expect(updated.status).toBe("pending");
    expect(updated.retry_count).toBe(1);
    expect(updated.retry_after).not.toBeNull();
  });
});

describe("completeTask", () => {
  it("marks the task completed and clears stale failure_reason", async () => {
    const [inserted] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-complete', 'Brief', 'active', 'Reached maximum turn limit')
      RETURNING *
    `;

    await completeTask(sql, inserted.id, "Recovered after retry");

    const [updated] = await sql`
      SELECT status, result_summary, failure_reason, completed_at
      FROM tasks WHERE id = ${inserted.id}
    `;
    expect(updated.status).toBe("completed");
    expect(updated.result_summary).toBe("Recovered after retry");
    expect(updated.failure_reason).toBeNull();
    expect(updated.completed_at).not.toBeNull();
  });

  it("marks the task completed and preserves explicit runtime warnings", async () => {
    const warning = "Codex rollout registration failed after agent output was captured; HiveWright persisted stdout directly.";
    const [inserted] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'claimer-test-complete-warning', 'Brief', 'active', 'Reached maximum turn limit')
      RETURNING *
    `;

    await completeTask(sql, inserted.id, "Recovered after retry", { runtimeWarnings: [warning] });

    const [updated] = await sql`
      SELECT status, result_summary, failure_reason, completed_at
      FROM tasks WHERE id = ${inserted.id}
    `;
    expect(updated.status).toBe("completed");
    expect(updated.result_summary).toBe("Recovered after retry");
    expect(updated.failure_reason).toBe(warning);
    expect(updated.completed_at).not.toBeNull();
  });
});

async function seedTwoStepPipelineForClaimedTask() {
  const [template] = await sql<{ id: string }[]>`
    INSERT INTO pipeline_templates (scope, hive_id, slug, name, department, final_output_contract, version, active)
    VALUES ('hive', ${bizId}, 'claimer-test-pipeline', 'Claimer Test Pipeline', 'engineering', ${sql.json({ artifactKind: "handoff", requiredFields: ["summary", "verification"] })}, 1, true)
    RETURNING id
  `;
  const steps = await sql<{ id: string; step_order: number }[]>`
    INSERT INTO pipeline_steps (template_id, step_order, slug, name, role_slug, duty, qa_required, output_contract, acceptance_criteria, drift_check)
    VALUES
      (${template.id}, 1, 'build', 'Build', 'claimer-test-role', 'Build the requested item.', false, ${sql.json({ artifactKind: "build", requiredFields: ["summary", "verification"] })}, 'Build must satisfy the source request.', ${sql.json({ mode: "source_similarity", threshold: 0.3 })}),
      (${template.id}, 2, 'review', 'Review', 'claimer-test-role', 'Review the requested item.', true, ${sql.json({ artifactKind: "review", requiredFields: ["verdict", "evidence"] })}, 'Review must produce a verdict.', ${sql.json({ mode: "source_similarity", threshold: 0.3 })})
    RETURNING id, step_order
  `;

  return { templateId: template.id, firstStepId: steps[0].id, secondStepId: steps[1].id };
}

describe("completeTask pipeline advancement", () => {
  it("advances a pipeline-created task and creates the next step task", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "Route this existing work through a pipeline.",
    });

    await completeTask(sql, started.taskId, `summary: Build completed through dispatcher path.
verification: unit checked.`);

    const stepRuns = await sql<{ step_id: string; task_id: string; status: string; result_summary: string | null }[]>`
      SELECT step_id, task_id, status, result_summary
      FROM pipeline_step_runs
      WHERE run_id = ${started.runId}
      ORDER BY created_at ASC
    `;
    const [run] = await sql<{ status: string; current_step_id: string }[]>`
      SELECT status, current_step_id FROM pipeline_runs WHERE id = ${started.runId}
    `;
    const [nextTask] = await sql<{ assigned_to: string; parent_task_id: string | null; qa_required: boolean }[]>`
      SELECT assigned_to, parent_task_id, qa_required FROM tasks WHERE id = ${stepRuns[1].task_id}
    `;

    expect(stepRuns).toHaveLength(2);
    expect(stepRuns[0]).toMatchObject({ step_id: pipeline.firstStepId, task_id: started.taskId, status: "complete", result_summary: `summary: Build completed through dispatcher path.
verification: unit checked.` });
    expect(stepRuns[1]).toMatchObject({ step_id: pipeline.secondStepId, status: "pending" });
    expect(run).toEqual({ status: "active", current_step_id: pipeline.secondStepId });
    expect(nextTask).toEqual({ assigned_to: "claimer-test-role", parent_task_id: started.taskId, qa_required: true });
  });

  it("advances when required output fields are markdown bold labels", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "Route this existing work through a pipeline.",
    });

    await completeTask(sql, started.taskId, `**summary**
Build completed through dispatcher path.

**verification**
Unit checked and source request preserved.`);

    const stepRuns = await sql<{ step_id: string; status: string; result_summary: string | null }[]>`
      SELECT step_id, status, result_summary
      FROM pipeline_step_runs
      WHERE run_id = ${started.runId}
      ORDER BY created_at ASC
    `;
    const [run] = await sql<{ status: string; current_step_id: string }[]>`
      SELECT status, current_step_id FROM pipeline_runs WHERE id = ${started.runId}
    `;

    expect(stepRuns).toHaveLength(2);
    expect(stepRuns[0]).toMatchObject({ step_id: pipeline.firstStepId, status: "complete" });
    expect(stepRuns[1]).toMatchObject({ step_id: pipeline.secondStepId, status: "pending" });
    expect(run).toEqual({ status: "active", current_step_id: pipeline.secondStepId });
  });

  it("does not create pipeline rows when completing a non-pipeline task", async () => {
    const [inserted] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'flat-task', 'Flat task', 'active')
      RETURNING id
    `;

    await completeTask(sql, inserted.id, "Flat task complete.");

    const [counts] = await sql<{ runs: number; step_runs: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM pipeline_runs) AS runs,
        (SELECT COUNT(*)::int FROM pipeline_step_runs) AS step_runs
    `;
    expect(counts).toEqual({ runs: 0, step_runs: 0 });
  });



  it("marks a claimed pipeline step as running", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "Route this existing work through a pipeline.",
    });

    const claimed = await claimNextTask(sql, process.pid);
    expect(claimed?.id).toBe(started.taskId);

    const [stepRun] = await sql<{ status: string }[]>`
      SELECT status FROM pipeline_step_runs WHERE task_id = ${started.taskId}
    `;
    expect(stepRun.status).toBe("running");
  });

  it("fails the pipeline cleanly when output contract fields are missing", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "Route this existing work through a pipeline.",
    });

    await completeTask(sql, started.taskId, "I did some work but did not provide the required labels.");

    const [run] = await sql<{ status: string; supervisor_handoff: string | null }[]>`
      SELECT status, supervisor_handoff FROM pipeline_runs WHERE id = ${started.runId}
    `;
    const [stepRun] = await sql<{ status: string; result_summary: string | null }[]>`
      SELECT status, result_summary FROM pipeline_step_runs WHERE task_id = ${started.taskId}
    `;
    const [task] = await sql<{ status: string; failure_reason: string | null }[]>`
      SELECT status, failure_reason FROM tasks WHERE id = ${started.taskId}
    `;

    expect(run.status).toBe("failed");
    expect(run.supervisor_handoff).toContain("Pipeline output contract failed");
    expect(stepRun.status).toBe("failed");
    expect(task.status).toBe("failed");
    expect(task.failure_reason).toContain("missing required field");
  });

  it("fails the pipeline cleanly when schema-valid output drifts from original source task intent", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    await sql`
      UPDATE pipeline_steps
      SET output_contract = ${sql.json({
        artifactKind: "build",
        requiredFields: ["summary", "verification", "status"],
        schema: {
          type: "object",
          required: ["summary", "verification", "status"],
          properties: {
            summary: { type: "string" },
            verification: { type: "array", items: { type: "string" } },
            status: { enum: ["pass", "fail"] },
          },
        },
      })}
      WHERE id = ${pipeline.firstStepId}
    `;
    const [sourceTask] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, retry_after)
      VALUES (${bizId}, 'claimer-test-role', 'owner', 'HiveWright blog post request', 'Write about HiveWright autonomous business operations and content strategy.', NOW() + INTERVAL '1 hour')
      RETURNING id
    `;
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "fallback source context",
      sourceTaskId: sourceTask.id,
    });

    await completeTask(sql, started.taskId, JSON.stringify({
      summary: "Prepared a frontend baseline implementation plan for responsive navigation.",
      verification: ["reviewed component tree"],
      status: "pass",
    }));

    const [run] = await sql<{ status: string; supervisor_handoff: string | null }[]>`
      SELECT status, supervisor_handoff FROM pipeline_runs WHERE id = ${started.runId}
    `;
    const [task] = await sql<{ status: string; failure_reason: string | null }[]>`
      SELECT status, failure_reason FROM tasks WHERE id = ${started.taskId}
    `;

    expect(run.status).toBe("failed");
    expect(run.supervisor_handoff).toContain("source intent");
    expect(task.status).toBe("failed");
    expect(task.failure_reason).toContain("source intent");
  });

  it("fails the pipeline instead of retrying when step retry cap is reached", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    await sql`UPDATE pipeline_steps SET max_retries = 0 WHERE id = ${pipeline.firstStepId}`;
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "Route this existing work through a pipeline.",
    });

    await releaseTask(sql, started.taskId, 60, "Pipeline step runtime exceeded configured max runtime.");

    const [run] = await sql<{ status: string; supervisor_handoff: string | null }[]>`
      SELECT status, supervisor_handoff FROM pipeline_runs WHERE id = ${started.runId}
    `;
    const [task] = await sql<{ status: string; retry_count: number; failure_reason: string | null }[]>`
      SELECT status, retry_count, failure_reason FROM tasks WHERE id = ${started.taskId}
    `;

    expect(run.status).toBe("failed");
    expect(run.supervisor_handoff).toContain("runtime exceeded");
    expect(task.status).toBe("failed");
    expect(task.retry_count).toBe(0);
  });

  it("does not advance a pipeline task twice when completion is retried", async () => {
    const pipeline = await seedTwoStepPipelineForClaimedTask();
    const started = await startPipelineRun(sql, {
      hiveId: bizId,
      templateId: pipeline.templateId,
      sourceContext: "Route this existing work through a pipeline.",
    });

    await completeTask(sql, started.taskId, `summary: First completion.
verification: checked.`);
    await completeTask(sql, started.taskId, `summary: Duplicate completion.
verification: checked.`);

    const stepRuns = await sql<{ step_id: string; status: string; result_summary: string | null }[]>`
      SELECT step_id, status, result_summary
      FROM pipeline_step_runs
      WHERE run_id = ${started.runId}
      ORDER BY created_at ASC
    `;

    expect(stepRuns).toHaveLength(2);
    expect(stepRuns[0]).toMatchObject({ step_id: pipeline.firstStepId, status: "complete", result_summary: `summary: First completion.
verification: checked.` });
    expect(stepRuns[1]).toMatchObject({ step_id: pipeline.secondStepId, status: "pending" });
  });
});
