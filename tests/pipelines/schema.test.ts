import { describe, expect, it, beforeEach } from "vitest";
import { createFixtureNamespace, testSql as sql, truncateAll } from "../_lib/test-db";
import {
  pipelineRuns,
  pipelineStepRuns,
  pipelineSteps,
  pipelineTemplates,
} from "../../src/db/schema";

describe("pipeline schema", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("persists templates, ordered steps, runs, and step runs", async () => {
    const ns = createFixtureNamespace("pipeline-schema");
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES (${ns.slug("hive")}, 'Pipeline Hive', 'digital')
      RETURNING id
    `;

    const [template] = await sql<{ id: string; version: number; department: string }[]>`
      INSERT INTO pipeline_templates (scope, hive_id, slug, name, department, description, version, active)
      VALUES ('hive', ${hive.id}, ${ns.slug("template")}, 'Release Pipeline', 'engineering', 'Ship safely', 2, true)
      RETURNING id, version, department
    `;

    const insertedSteps = await sql<{ id: string; step_order: number; role_slug: string; qa_required: boolean }[]>`
      INSERT INTO pipeline_steps (
        template_id,
        step_order,
        slug,
        name,
        role_slug,
        duty,
        skill_slugs,
        connector_capabilities,
        qa_required
      )
      VALUES
        (${template.id}, 1, 'plan', 'Plan', 'dev-agent', 'Draft implementation plan', ${sql.json(["planning"])}, ${sql.json(["github"])}, false),
        (${template.id}, 2, 'verify', 'Verify', 'qa', 'Verify implementation', ${sql.json(["testing"])}, ${sql.json([])}, true)
      RETURNING id, step_order, role_slug, qa_required
    `;

    const [run] = await sql<{ id: string; status: string; template_version: number }[]>`
      INSERT INTO pipeline_runs (hive_id, template_id, template_version, status, current_step_id)
      VALUES (${hive.id}, ${template.id}, ${template.version}, 'active', ${insertedSteps[0].id})
      RETURNING id, status, template_version
    `;

    const [stepRun] = await sql<{ id: string; status: string }[]>`
      INSERT INTO pipeline_step_runs (run_id, step_id, status)
      VALUES (${run.id}, ${insertedSteps[0].id}, 'pending')
      RETURNING id, status
    `;

    expect(template.department).toBe("engineering");
    expect(insertedSteps.map((step) => step.step_order)).toEqual([1, 2]);
    expect(insertedSteps[1].qa_required).toBe(true);
    expect(run.template_version).toBe(2);
    expect(run.status).toBe("active");
    expect(stepRun.status).toBe("pending");
    expect(pipelineTemplates).toBeDefined();
    expect(pipelineSteps).toBeDefined();
    expect(pipelineRuns).toBeDefined();
    expect(pipelineStepRuns).toBeDefined();
  });

  it("prevents duplicate global template slug versions", async () => {
    const ns = createFixtureNamespace("pipeline-global-unique");

    await sql`
      INSERT INTO pipeline_templates (scope, hive_id, slug, name, department, version, active)
      VALUES ('global', NULL, ${ns.slug("template")}, 'Global Pipeline', 'engineering', 1, true)
    `;

    await expect(sql`
      INSERT INTO pipeline_templates (scope, hive_id, slug, name, department, version, active)
      VALUES ('global', NULL, ${ns.slug("template")}, 'Duplicate Global Pipeline', 'engineering', 1, true)
    `).rejects.toThrow();
  });

  it("enforces execution rules on pipeline steps", async () => {
    const ns = createFixtureNamespace("pipeline-execution-rules");
    const [template] = await sql<{ id: string }[]>`
      INSERT INTO pipeline_templates (
        scope,
        hive_id,
        slug,
        name,
        department,
        description,
        mode,
        default_sla_seconds,
        max_total_cost_cents,
        final_output_contract,
        dashboard_visibility_policy,
        version,
        active
      )
      VALUES (
        'global',
        NULL,
        ${ns.slug("template")},
        'Fast Content Pipeline',
        'content',
        'Bounded content production',
        'production',
        600,
        250,
        ${sql.json({ artifactKind: "blog_post", requiredFields: ["title", "body"] })},
        'summary_artifacts_only',
        1,
        true
      )
      RETURNING id
    `;

    const [step] = await sql<{
      max_runtime_seconds: number;
      max_retries: number;
      max_cost_cents: number;
      output_contract: { artifactKind: string };
      failure_policy: string;
      drift_check: { mode: string };
    }[]>`
      INSERT INTO pipeline_steps (
        template_id,
        step_order,
        slug,
        name,
        role_slug,
        duty,
        qa_required,
        max_runtime_seconds,
        max_retries,
        max_cost_cents,
        output_contract,
        failure_policy,
        drift_check
      )
      VALUES (
        ${template.id},
        1,
        'draft',
        'Draft',
        'content-writer',
        'Write a bounded first draft.',
        false,
        180,
        1,
        100,
        ${sql.json({ artifactKind: "blog_draft", requiredFields: ["title", "body"] })},
        'retry_then_fail',
        ${sql.json({ mode: "source_similarity", threshold: 0.35 })}
      )
      RETURNING max_runtime_seconds, max_retries, max_cost_cents, output_contract, failure_policy, drift_check
    `;

    expect(step.max_runtime_seconds).toBe(180);
    expect(step.max_retries).toBe(1);
    expect(step.max_cost_cents).toBe(100);
    expect(step.output_contract.artifactKind).toBe("blog_draft");
    expect(step.failure_policy).toBe("retry_then_fail");
    expect(step.drift_check.mode).toBe("source_similarity");

    await expect(sql`
      INSERT INTO pipeline_steps (
        template_id,
        step_order,
        slug,
        name,
        role_slug,
        duty,
        qa_required,
        max_runtime_seconds,
        max_retries,
        max_cost_cents,
        output_contract,
        failure_policy,
        drift_check
      )
      VALUES (
        ${template.id},
        2,
        'unbounded',
        'Unbounded',
        'content-writer',
        'Do open-ended work.',
        false,
        0,
        1,
        50,
        ${sql.json({ artifactKind: "note" })},
        'retry_then_fail',
        ${sql.json({ mode: "source_similarity" })}
      )
    `).rejects.toThrow();
  });

  it("leaves existing non-pipeline tasks compatible", async () => {
    const ns = createFixtureNamespace("pipeline-task-compat");
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES (${ns.slug("hive")}, 'Flat Task Hive', 'digital')
      RETURNING id
    `;

    const [task] = await sql<{ id: string; status: string; assigned_to: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${hive.id}, 'dev-agent', 'owner', 'Flat task', 'No pipeline required')
      RETURNING id, status, assigned_to
    `;

    const stepRuns = await sql<{ id: string }[]>`
      SELECT id FROM pipeline_step_runs WHERE task_id = ${task.id}
    `;

    expect(task.status).toBe("pending");
    expect(task.assigned_to).toBe("dev-agent");
    expect(stepRuns).toEqual([]);
  });
});
