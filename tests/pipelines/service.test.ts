import { beforeEach, describe, expect, it } from "vitest";
import {
  startPipelineRun,
  advancePipelineRunFromTask,
  validatePipelineOutputContract,
} from "../../src/pipelines/service";
import { createFixtureNamespace, testSql as sql, truncateAll } from "../_lib/test-db";

async function seedPipelineFixture() {
  const ns = createFixtureNamespace("pipeline-service");
  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type)
    VALUES (${ns.slug("hive")}, 'Service Pipeline Hive', 'digital')
    RETURNING id
  `;
  const [template] = await sql<{ id: string; version: number }[]>`
    INSERT INTO pipeline_templates (
      scope,
      hive_id,
      slug,
      name,
      department,
      final_output_contract,
      version,
      active
    )
    VALUES (
      'hive',
      ${hive.id},
      ${ns.slug("template")},
      'Two Step Pipeline',
      'engineering',
      ${sql.json({ artifactKind: "handoff", requiredFields: ["summary", "verification"] })},
      3,
      true
    )
    RETURNING id, version
  `;
  const steps = await sql<{ id: string; step_order: number; slug: string }[]>`
    INSERT INTO pipeline_steps (
      template_id,
      step_order,
      slug,
      name,
      role_slug,
      duty,
      skill_slugs,
      connector_capabilities,
      qa_required,
      output_contract,
      acceptance_criteria,
      drift_check
    )
    VALUES
      (${template.id}, 1, 'build', 'Build', 'dev-agent', 'Implement the requested change only.', ${sql.json(["implementation"])}, ${sql.json(["filesystem"])}, false, ${sql.json({ artifactKind: "code_change", requiredFields: ["summary", "verification"] })}, 'Implementation must satisfy the source request.', ${sql.json({ mode: "source_similarity", threshold: 0.3 })}),
      (${template.id}, 2, 'review', 'Review', 'qa', 'Review the implementation and report defects.', ${sql.json(["qa"])}, ${sql.json([])}, true, ${sql.json({ artifactKind: "qa_verdict", requiredFields: ["verdict", "evidence"] })}, 'Review must produce a clear verdict.', ${sql.json({ mode: "source_similarity", threshold: 0.3 })})
    RETURNING id, step_order, slug
  `;

  return { hiveId: hive.id, templateId: template.id, templateVersion: template.version, firstStepId: steps[0].id, secondStepId: steps[1].id };
}

describe("pipeline output contract validation", () => {
  it("accepts JSON output that satisfies required fields and schema types", () => {
    const result = validatePipelineOutputContract(
      JSON.stringify({
        summary: "Implemented bounded runtime checks.",
        verification: ["npm test", "npm run typecheck"],
        status: "pass",
      }),
      {
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
      },
    );

    expect(result).toEqual({ valid: true, missingFields: [], invalidFields: [], driftIssues: [] });
  });

  it("rejects non-JSON prose when a schema-backed contract requires machine-readable output", () => {
    const result = validatePipelineOutputContract(
      "summary: Looks okay\nverification: npm test\nstatus: pass",
      {
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
      },
    );

    expect(result.valid).toBe(false);
    expect(result.invalidFields).toContain("output: expected JSON object matching contract schema");
  });

  it("rejects JSON output with wrong field types or enum values", () => {
    const result = validatePipelineOutputContract(
      JSON.stringify({ summary: "Checked", verification: "npm test", status: "maybe" }),
      {
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
      },
    );

    expect(result.valid).toBe(false);
    expect(result.missingFields).toEqual([]);
    expect(result.invalidFields).toEqual([
      "verification: expected array",
      "status: expected one of pass, fail",
    ]);
  });

  it("accepts markdown headings for prose-only required fields", () => {
    const result = validatePipelineOutputContract(
      "**summary**\n- Work completed.\n\n## Verification\n- npm test passed.",
      { requiredFields: ["summary", "verification"] },
    );

    expect(result).toEqual({ valid: true, missingFields: [], invalidFields: [], driftIssues: [] });
  });

  it("rejects structurally valid output that has drifted away from source intent", () => {
    const result = validatePipelineOutputContract(
      JSON.stringify({
        summary: "Prepared a frontend baseline implementation plan for responsive navigation.",
        verification: ["reviewed component tree"],
        status: "pass",
      }),
      {
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
      },
      {
        sourceContext: "Write a HiveWright blog post about autonomous business operations and content strategy.",
        driftCheck: { mode: "source_similarity", threshold: 0.3 },
      },
    );

    expect(result.valid).toBe(false);
    expect(result.driftIssues).toContain("output drifted from source intent: source similarity below 0.3");
  });
});
describe("pipeline service", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("starts a run with the first step run and task", async () => {
    const fixture = await seedPipelineFixture();

    const result = await startPipelineRun(sql, {
      hiveId: fixture.hiveId,
      templateId: fixture.templateId,
      sourceContext: "Owner asked for a small website change.",
    });

    expect(result.runId).toBeTruthy();
    expect(result.taskId).toBeTruthy();
    expect(result.stepRunId).toBeTruthy();

    const [run] = await sql<{ status: string; current_step_id: string; template_version: number }[]>`
      SELECT status, current_step_id, template_version FROM pipeline_runs WHERE id = ${result.runId}
    `;
    const [stepRun] = await sql<{ status: string; step_id: string; task_id: string }[]>`
      SELECT status, step_id, task_id FROM pipeline_step_runs WHERE id = ${result.stepRunId}
    `;
    const [task] = await sql<{ assigned_to: string; title: string; brief: string; qa_required: boolean }[]>`
      SELECT assigned_to, title, brief, qa_required FROM tasks WHERE id = ${result.taskId}
    `;

    expect(run).toEqual({ status: "active", current_step_id: fixture.firstStepId, template_version: fixture.templateVersion });
    expect(stepRun).toEqual({ status: "pending", step_id: fixture.firstStepId, task_id: result.taskId });
    expect(task.assigned_to).toBe("dev-agent");
    expect(task.title).toContain("Build");
    expect(task.brief).toContain("Implement the requested change only.");
    expect(task.brief).toContain("Owner asked for a small website change.");
    expect(task.qa_required).toBe(false);
  });

  it("advances a completed step by creating the next step task", async () => {
    const fixture = await seedPipelineFixture();
    const started = await startPipelineRun(sql, {
      hiveId: fixture.hiveId,
      templateId: fixture.templateId,
      sourceContext: "Initial request context.",
    });

    const advanced = await advancePipelineRunFromTask(sql, {
      taskId: started.taskId,
      resultSummary: "Build is complete.",
    });

    expect(advanced.status).toBe("advanced");
    if (advanced.status !== "advanced") throw new Error("Expected pipeline to advance");
    expect(advanced.taskId).toBeTruthy();

    const stepRuns = await sql<{ step_id: string; task_id: string; status: string; result_summary: string | null }[]>`
      SELECT step_id, task_id, status, result_summary
      FROM pipeline_step_runs
      WHERE run_id = ${started.runId}
      ORDER BY created_at ASC
    `;
    const [run] = await sql<{ status: string; current_step_id: string }[]>`
      SELECT status, current_step_id FROM pipeline_runs WHERE id = ${started.runId}
    `;
    const [nextTask] = await sql<{ assigned_to: string; brief: string; qa_required: boolean }[]>`
      SELECT assigned_to, brief, qa_required FROM tasks WHERE id = ${advanced.taskId}
    `;

    expect(stepRuns).toHaveLength(2);
    expect(stepRuns[0]).toMatchObject({ step_id: fixture.firstStepId, task_id: started.taskId, status: "complete", result_summary: "Build is complete." });
    expect(stepRuns[1]).toMatchObject({ step_id: fixture.secondStepId, task_id: advanced.taskId, status: "pending" });
    expect(run).toEqual({ status: "active", current_step_id: fixture.secondStepId });
    expect(nextTask.assigned_to).toBe("qa");
    expect(nextTask.brief).toContain("Review the implementation and report defects.");
    expect(nextTask.brief).toContain("Previous step result:\nBuild is complete.");
    expect(nextTask.qa_required).toBe(true);
  });

  it("propagates goal and sprint metadata to every pipeline step task so completion wakes the goal supervisor", async () => {
    const fixture = await seedPipelineFixture();
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${fixture.hiveId}, 'Pipeline supervisor handoff goal', 'active', 'gs-pipeline-test')
      RETURNING id
    `;

    const started = await startPipelineRun(sql, {
      hiveId: fixture.hiveId,
      templateId: fixture.templateId,
      sourceContext: "Run the governed pipeline as sprint 3.",
      goalId: goal.id,
      sprintNumber: 3,
    });
    const advanced = await advancePipelineRunFromTask(sql, {
      taskId: started.taskId,
      resultSummary: "Build is complete.",
    });

    expect(advanced.status).toBe("advanced");
    if (advanced.status !== "advanced") throw new Error("Expected pipeline to advance");

    const tasks = await sql<{ id: string; goal_id: string | null; sprint_number: number | null }[]>`
      SELECT id, goal_id, sprint_number
      FROM tasks
      WHERE id IN (${started.taskId}, ${advanced.taskId})
      ORDER BY created_at ASC
    `;

    expect(tasks).toEqual([
      { id: started.taskId, goal_id: goal.id, sprint_number: 3 },
      { id: advanced.taskId, goal_id: goal.id, sprint_number: 3 },
    ]);
  });

  it("keeps the original source task context when creating downstream step briefs", async () => {
    const fixture = await seedPipelineFixture();
    const [sourceTask] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${fixture.hiveId}, 'content-writer', 'owner', 'Original blog post request', 'Write about HiveWright content strategy.')
      RETURNING id
    `;
    const started = await startPipelineRun(sql, {
      hiveId: fixture.hiveId,
      templateId: fixture.templateId,
      sourceContext: "Original fallback context.",
      sourceTaskId: sourceTask.id,
    });

    const advanced = await advancePipelineRunFromTask(sql, {
      taskId: started.taskId,
      resultSummary: "Build is complete.",
    });

    expect(advanced.status).toBe("advanced");
    if (advanced.status !== "advanced") throw new Error("Expected pipeline to advance");
    const [nextTask] = await sql<{ brief: string }[]>`
      SELECT brief FROM tasks WHERE id = ${advanced.taskId}
    `;

    expect(nextTask.brief).toContain("Source task: Original blog post request");
    expect(nextTask.brief).toContain("Write about HiveWright content strategy.");
    expect(nextTask.brief).toContain("Previous step result:\nBuild is complete.");
  });


  it("rejects templates that do not define governed execution rules", async () => {
    const ns = createFixtureNamespace("pipeline-invalid-rules");
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES (${ns.slug("hive")}, 'Invalid Rules Hive', 'digital')
      RETURNING id
    `;
    const [template] = await sql<{ id: string }[]>`
      INSERT INTO pipeline_templates (scope, hive_id, slug, name, department, version, active)
      VALUES ('hive', ${hive.id}, ${ns.slug("template")}, 'Ungoverned Pipeline', 'content', 1, true)
      RETURNING id
    `;
    await sql`
      INSERT INTO pipeline_steps (template_id, step_order, slug, name, role_slug, duty)
      VALUES (${template.id}, 1, 'draft', 'Draft', 'content-writer', 'Write something useful')
    `;

    await expect(startPipelineRun(sql, {
      hiveId: hive.id,
      templateId: template.id,
      sourceContext: "Write a bounded HiveWright blog post.",
    })).rejects.toThrow(/Pipeline template failed validation/);
  });

  it("rejects cross-hive source references when starting a run", async () => {
    const fixture = await seedPipelineFixture();
    const ns = createFixtureNamespace("pipeline-cross-hive");
    const [otherHive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES (${ns.slug("other-hive")}, 'Other Hive', 'digital')
      RETURNING id
    `;
    const [otherTask] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${otherHive.id}, 'dev-agent', 'owner', 'Other task', 'Belongs to another hive')
      RETURNING id
    `;

    await expect(startPipelineRun(sql, {
      hiveId: fixture.hiveId,
      templateId: fixture.templateId,
      sourceContext: "Should not cross tenant boundary.",
      sourceTaskId: otherTask.id,
    })).rejects.toThrow(/sourceTaskId does not belong to hive/);
  });

  it("completes the final step and records supervisor handoff", async () => {
    const fixture = await seedPipelineFixture();
    const started = await startPipelineRun(sql, {
      hiveId: fixture.hiveId,
      templateId: fixture.templateId,
      sourceContext: "Initial request context.",
    });
    const advanced = await advancePipelineRunFromTask(sql, {
      taskId: started.taskId,
      resultSummary: "Build is complete.",
    });
    expect(advanced.status).toBe("advanced");
    if (advanced.status !== "advanced") throw new Error("Expected pipeline to advance");

    const completed = await advancePipelineRunFromTask(sql, {
      taskId: advanced.taskId,
      resultSummary: "Review passed.",
      supervisorHandoff: "Ready for owner approval.",
    });

    expect(completed).toEqual({ status: "completed", runId: started.runId });

    const [run] = await sql<{ status: string; current_step_id: string | null; supervisor_handoff: string | null }[]>`
      SELECT status, current_step_id, supervisor_handoff FROM pipeline_runs WHERE id = ${started.runId}
    `;
    const [finalStepRun] = await sql<{ status: string; result_summary: string | null }[]>`
      SELECT status, result_summary FROM pipeline_step_runs WHERE task_id = ${advanced.taskId}
    `;

    expect(run).toEqual({ status: "complete", current_step_id: null, supervisor_handoff: "Ready for owner approval." });
    expect(finalStepRun).toEqual({ status: "complete", result_summary: "Review passed." });
  });
});
