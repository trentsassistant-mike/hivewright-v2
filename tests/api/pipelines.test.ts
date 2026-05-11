import { beforeEach, describe, expect, it } from "vitest";
import { DELETE, GET, PATCH, POST, PUT } from "@/app/api/pipelines/route";
import { createFixtureNamespace, testSql as sql, truncateAll } from "../_lib/test-db";

async function seedTemplateAndRun() {
  const ns = createFixtureNamespace("pipelines-api");
  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type)
    VALUES (${ns.slug("hive")}, 'API Pipeline Hive', 'digital')
    RETURNING id
  `;
  const [template] = await sql<{ id: string }[]>`
    INSERT INTO pipeline_templates (scope, hive_id, slug, name, department, final_output_contract, version, active)
    VALUES ('hive', ${hive.id}, ${ns.slug("template")}, 'API Pipeline', 'engineering', ${sql.json({ artifactKind: "handoff", requiredFields: ["summary", "verification"] })}, 1, true)
    RETURNING id
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES
      ('dev-agent', 'Dev Agent', 'executor', 'claude-code'),
      ('qa-agent', 'QA Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  const steps = await sql<{ id: string; name: string }[]>`
    INSERT INTO pipeline_steps (template_id, step_order, slug, name, role_slug, duty, qa_required, output_contract, acceptance_criteria, drift_check)
    VALUES
      (${template.id}, 1, 'plan', 'Plan', 'dev-agent', 'Plan the requested change', false, ${sql.json({ artifactKind: "plan", requiredFields: ["scope", "acceptanceCriteria"] })}, 'Plan must be bounded to source task.', ${sql.json({ mode: "source_similarity", threshold: 0.3 })}),
      (${template.id}, 2, 'build', 'Build', 'dev-agent', 'Build the requested change', true, ${sql.json({ artifactKind: "build", requiredFields: ["changedFiles", "verification"] })}, 'Build must satisfy scoped plan.', ${sql.json({ mode: "source_similarity", threshold: 0.3 })}),
      (${template.id}, 3, 'review', 'Review', 'qa-agent', 'Review the implementation', false, ${sql.json({ artifactKind: "review", requiredFields: ["verdict", "evidence"] })}, 'Review must produce a verdict.', ${sql.json({ mode: "source_similarity", threshold: 0.3 })})
    RETURNING id, name
  `;
  const currentStep = steps.find((step) => step.name === "Build") ?? steps[1];
  const [run] = await sql<{ id: string }[]>`
    INSERT INTO pipeline_runs (hive_id, template_id, template_version, status, current_step_id)
    VALUES (${hive.id}, ${template.id}, 1, 'active', ${currentStep.id})
    RETURNING id
  `;
  await sql`
    INSERT INTO pipeline_step_runs (run_id, step_id, status, result_summary, completed_at)
    VALUES
      (${run.id}, ${steps[0].id}, 'complete', 'Plan approved', now()),
      (${run.id}, ${currentStep.id}, 'running', null, null)
  `;

  return { hiveId: hive.id, templateId: template.id, runId: run.id, firstStepId: steps[0].id, stepIds: steps.map((step) => step.id) };
}

describe("GET /api/pipelines", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("lists active templates and hive runs", async () => {
    const fixture = await seedTemplateAndRun();

    const res = await GET(new Request(`http://localhost/api/pipelines?hiveId=${fixture.hiveId}`));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.templates.length).toBeGreaterThanOrEqual(1);
    const hiveTemplate = body.data.templates.find((template: { id: string }) => template.id === fixture.templateId);
    expect(hiveTemplate).toBeDefined();
    if (!hiveTemplate) throw new Error("Expected hive pipeline template in response");
    expect(hiveTemplate).toMatchObject({
      id: fixture.templateId,
      name: "API Pipeline",
      department: "engineering",
      scope: "hive",
      stepCount: 3,
    });
    expect(hiveTemplate.steps).toEqual([
      expect.objectContaining({ id: fixture.stepIds[0], order: 1, name: "Plan", roleSlug: "dev-agent" }),
      expect.objectContaining({ id: fixture.stepIds[1], order: 2, name: "Build", qaRequired: true }),
      expect.objectContaining({ id: fixture.stepIds[2], order: 3, name: "Review", roleSlug: "qa-agent" }),
    ]);
    expect(body.data.runs).toHaveLength(1);
    expect(body.data.runs[0]).toMatchObject({
      id: fixture.runId,
      status: "active",
      templateId: fixture.templateId,
      currentStepName: "Build",
      currentStepOrder: 2,
    });
    expect(body.data.runs[0].steps).toEqual([
      expect.objectContaining({ id: fixture.stepIds[0], order: 1, name: "Plan", status: "complete", current: false, resultSummary: "Plan approved" }),
      expect.objectContaining({ id: fixture.stepIds[1], order: 2, name: "Build", status: "running", current: true }),
      expect.objectContaining({ id: fixture.stepIds[2], order: 3, name: "Review", status: "pending", current: false }),
    ]);
  });

  it("includes inactive draft templates in the owner dashboard read model when requested", async () => {
    const fixture = await seedTemplateAndRun();
    const ns = createFixtureNamespace("pipelines-api-draft");
    const [draftTemplate] = await sql<{ id: string }[]>`
      INSERT INTO pipeline_templates (scope, hive_id, slug, name, department, final_output_contract, version, active)
      VALUES ('hive', ${fixture.hiveId}, ${ns.slug("template")}, 'Draft SOP Capture', 'operations', ${sql.json({ artifactKind: "draft", requiredFields: ["summary"] })}, 1, false)
      RETURNING id
    `;

    const res = await GET(new Request(`http://localhost/api/pipelines?hiveId=${fixture.hiveId}&includeInactive=true`));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: fixture.templateId, active: true }),
        expect.objectContaining({ id: draftTemplate.id, name: "Draft SOP Capture", active: false }),
      ]),
    );
  });

  it("defaults to active templates only for execution surfaces", async () => {
    const fixture = await seedTemplateAndRun();
    const ns = createFixtureNamespace("pipelines-api-active-only");
    const [draftTemplate] = await sql<{ id: string }[]>`
      INSERT INTO pipeline_templates (scope, hive_id, slug, name, department, final_output_contract, version, active)
      VALUES ('hive', ${fixture.hiveId}, ${ns.slug("template")}, 'Inactive Execution Candidate', 'operations', ${sql.json({ artifactKind: "draft", requiredFields: ["summary"] })}, 1, false)
      RETURNING id
    `;

    const res = await GET(new Request(`http://localhost/api/pipelines?hiveId=${fixture.hiveId}`));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.templates.map((template: { id: string }) => template.id)).toContain(fixture.templateId);
    expect(body.data.templates.map((template: { id: string }) => template.id)).not.toContain(draftTemplate.id);
  });
});

describe("POST /api/pipelines", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("starts a pipeline from an existing source task and links the first pipeline task", async () => {
    const fixture = await seedTemplateAndRun();
    const [sourceTask] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${fixture.hiveId}, 'dev-agent', 'owner', 'Build an intake form', 'Owner needs a validated intake form.')
      RETURNING id
    `;

    const res = await POST(new Request("http://localhost/api/pipelines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: fixture.hiveId,
        templateId: fixture.templateId,
        sourceTaskId: sourceTask.id,
      }),
    }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({
      runId: expect.any(String),
      stepRunId: expect.any(String),
      taskId: expect.any(String),
    });

    const [run] = await sql<{ source_task_id: string | null; current_step_id: string | null }[]>`
      SELECT source_task_id, current_step_id FROM pipeline_runs WHERE id = ${body.data.runId}
    `;
    const [stepRun] = await sql<{ task_id: string; step_id: string; status: string }[]>`
      SELECT task_id, step_id, status FROM pipeline_step_runs WHERE id = ${body.data.stepRunId}
    `;
    const [pipelineTask] = await sql<{ parent_task_id: string | null; brief: string }[]>`
      SELECT parent_task_id, brief FROM tasks WHERE id = ${body.data.taskId}
    `;

    expect(run).toEqual({ source_task_id: sourceTask.id, current_step_id: fixture.firstStepId });
    expect(stepRun).toEqual({ task_id: body.data.taskId, step_id: fixture.firstStepId, status: "pending" });
    expect(pipelineTask.parent_task_id).toBe(sourceTask.id);
    expect(pipelineTask.brief).toContain("Build an intake form");
    expect(pipelineTask.brief).toContain("Owner needs a validated intake form.");
  });

  it("starts a pipeline directly from goal context when no source task exists", async () => {
    const fixture = await seedTemplateAndRun();
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, description, status, session_id)
      VALUES (${fixture.hiveId}, 'Create Facebook ad', 'Need a Facebook ad for the latest offer.', 'active', '/tmp/supervisor-session')
      RETURNING id
    `;

    const res = await POST(new Request("http://localhost/api/pipelines", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Supervisor-Session": "/tmp/supervisor-session" },
      body: JSON.stringify({
        hiveId: fixture.hiveId,
        templateId: fixture.templateId,
        goalId: goal.id,
        sourceContext: "Facebook ad intake: produce compliant ad copy and creative handoff.",
        sprintNumber: 1,
        selectionRationale: "content pipeline fits Facebook ad creation",
        confidence: 0.9,
      }),
    }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.runId).toEqual(expect.any(String));

    const [run] = await sql<{ source_task_id: string | null; goal_id: string | null; current_step_id: string | null; supervisor_handoff: string | null }[]>`
      SELECT source_task_id, goal_id, current_step_id, supervisor_handoff FROM pipeline_runs WHERE id = ${body.data.runId}
    `;
    const [pipelineTask] = await sql<{ goal_id: string | null; parent_task_id: string | null; brief: string }[]>`
      SELECT goal_id, parent_task_id, brief FROM tasks WHERE id = ${body.data.taskId}
    `;

    expect(run.source_task_id).toBeNull();
    expect(run.goal_id).toBe(goal.id);
    expect(run.current_step_id).toBe(fixture.firstStepId);
    expect(run.supervisor_handoff).toContain("selection_rationale: content pipeline fits Facebook ad creation");
    expect(pipelineTask.goal_id).toBe(goal.id);
    expect(pipelineTask.parent_task_id).toBeNull();
    expect(pipelineTask.brief).toContain("Facebook ad intake");
  });

  it("rejects an active duplicate pipeline run for the same source task", async () => {
    const fixture = await seedTemplateAndRun();
    const [sourceTask] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${fixture.hiveId}, 'dev-agent', 'owner', 'Already routed work', 'Do not duplicate active work.')
      RETURNING id
    `;
    await sql`
      INSERT INTO pipeline_runs (hive_id, template_id, template_version, status, source_task_id, current_step_id)
      VALUES (${fixture.hiveId}, ${fixture.templateId}, 1, 'active', ${sourceTask.id}, ${fixture.firstStepId})
    `;

    const res = await POST(new Request("http://localhost/api/pipelines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: fixture.hiveId,
        templateId: fixture.templateId,
        sourceTaskId: sourceTask.id,
      }),
    }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already has an active pipeline run/i);
  });

  it("rejects a source task from another hive", async () => {
    const fixture = await seedTemplateAndRun();
    const ns = createFixtureNamespace("pipelines-api-cross-hive");
    const [otherHive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES (${ns.slug("other-hive")}, 'Other Hive', 'digital')
      RETURNING id
    `;
    const [otherTask] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${otherHive.id}, 'dev-agent', 'owner', 'Other task', 'Wrong hive')
      RETURNING id
    `;

    const res = await POST(new Request("http://localhost/api/pipelines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: fixture.hiveId,
        templateId: fixture.templateId,
        sourceTaskId: otherTask.id,
      }),
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/sourceTaskId does not belong to hive/i);
  });

  it("rejects inactive templates when starting a pipeline run", async () => {
    const fixture = await seedTemplateAndRun();
    const ns = createFixtureNamespace("pipelines-api-post-inactive");
    const [inactiveTemplate] = await sql<{ id: string }[]>`
      INSERT INTO pipeline_templates (scope, hive_id, slug, name, department, final_output_contract, version, active)
      VALUES ('hive', ${fixture.hiveId}, ${ns.slug("template")}, 'Inactive Procedure', 'operations', ${sql.json({ artifactKind: "draft", requiredFields: ["summary"] })}, 1, false)
      RETURNING id
    `;
    const [sourceTask] = await sql<{ id: string }[]>`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief)
      VALUES (${fixture.hiveId}, 'dev-agent', 'owner', 'Draft-only work', 'Inactive template must not run.')
      RETURNING id
    `;

    const res = await POST(new Request("http://localhost/api/pipelines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: fixture.hiveId,
        templateId: inactiveTemplate.id,
        sourceTaskId: sourceTask.id,
      }),
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not found or inactive/i);
  });
});

describe("procedure template management", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("creates an approved hive procedure template with ordered steps", async () => {
    const ns = createFixtureNamespace("pipelines-api-create");
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES (${ns.slug("hive")}, 'Procedure Create Hive', 'digital')
      RETURNING id
    `;
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('ops-agent', 'Ops Agent', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;

    const res = await PUT(new Request("http://localhost/api/pipelines", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: hive.id,
        name: "Owner Intake Review",
        department: "operations",
        active: true,
        steps: [
          { order: 1, name: "Review intake", roleSlug: "ops-agent", duty: "Review the submitted owner intake." },
          { order: 2, name: "Prepare handoff", roleSlug: "ops-agent", duty: "Prepare the process-bound handoff." },
        ],
      }),
    }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({
      hiveId: hive.id,
      name: "Owner Intake Review",
      slug: "owner-intake-review",
      department: "operations",
      active: true,
      stepCount: 2,
    });
    expect(body.data.steps).toEqual([
      expect.objectContaining({ order: 1, slug: "review-intake", name: "Review intake", roleSlug: "ops-agent" }),
      expect.objectContaining({ order: 2, slug: "prepare-handoff", name: "Prepare handoff", roleSlug: "ops-agent" }),
    ]);
  });

  it("updates template metadata and fully replaces ordered steps", async () => {
    const ns = createFixtureNamespace("pipelines-api-update");
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES (${ns.slug("hive")}, 'Procedure Update Hive', 'digital')
      RETURNING id
    `;
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES
        ('dev-agent', 'Dev Agent', 'executor', 'claude-code'),
        ('qa-agent', 'QA Agent', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;
    const [template] = await sql<{ id: string }[]>`
      INSERT INTO pipeline_templates (scope, hive_id, slug, name, department, final_output_contract, version, active)
      VALUES ('hive', ${hive.id}, ${ns.slug("template")}, 'Original Procedure', 'engineering', ${sql.json({ artifactKind: "handoff", requiredFields: ["summary"] })}, 1, true)
      RETURNING id
    `;
    const oldSteps = await sql<{ id: string }[]>`
      INSERT INTO pipeline_steps (template_id, step_order, slug, name, role_slug, duty, output_contract, acceptance_criteria, drift_check)
      VALUES
        (${template.id}, 1, 'original-one', 'Original one', 'dev-agent', 'Original duty one.', ${sql.json({ requiredFields: ["summary"] })}, 'Summarize the work.', ${sql.json({ mode: "source_similarity", threshold: 0.3 })}),
        (${template.id}, 2, 'original-two', 'Original two', 'qa-agent', 'Original duty two.', ${sql.json({ requiredFields: ["summary"] })}, 'Summarize the work.', ${sql.json({ mode: "source_similarity", threshold: 0.3 })})
      RETURNING id
    `;

    const res = await PATCH(new Request("http://localhost/api/pipelines", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: hive.id,
        templateId: template.id,
        name: "Updated Procedure",
        slug: "updated-procedure",
        department: "operations",
        description: "Updated owner-approved operating procedure.",
        active: true,
        steps: [
          { order: 1, name: "Triage", roleSlug: "dev-agent", duty: "Triage the request." },
          { order: 2, name: "Verify", roleSlug: "qa-agent", duty: "Verify the result.", qaRequired: true },
        ],
      }),
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      id: template.id,
      name: "Updated Procedure",
      slug: "updated-procedure",
      department: "operations",
      active: true,
      stepCount: 2,
    });
    expect(body.data.steps).toEqual([
      expect.objectContaining({ order: 1, name: "Triage", roleSlug: "dev-agent" }),
      expect.objectContaining({ order: 2, name: "Verify", roleSlug: "qa-agent", qaRequired: true }),
    ]);

    const remainingOldSteps = await sql<{ id: string }[]>`
      SELECT id FROM pipeline_steps WHERE id = ANY(${oldSteps.map((step) => step.id)})
    `;
    expect(remainingOldSteps).toHaveLength(0);
  });

  it("archives a template and keeps it out of execution reads", async () => {
    const fixture = await seedTemplateAndRun();

    const res = await PATCH(new Request("http://localhost/api/pipelines", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: fixture.hiveId,
        templateId: fixture.templateId,
        active: false,
      }),
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ id: fixture.templateId, active: false });

    const activeOnly = await GET(new Request(`http://localhost/api/pipelines?hiveId=${fixture.hiveId}`));
    const activeBody = await activeOnly.json();
    expect(activeBody.data.templates.map((template: { id: string }) => template.id)).not.toContain(fixture.templateId);

    const ownerHub = await GET(new Request(`http://localhost/api/pipelines?hiveId=${fixture.hiveId}&includeInactive=true`));
    const ownerBody = await ownerHub.json();
    expect(ownerBody.data.templates).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: fixture.templateId, active: false })]),
    );
  });

  it("safe-archives instead of hard deleting templates with run history", async () => {
    const fixture = await seedTemplateAndRun();

    const res = await DELETE(new Request("http://localhost/api/pipelines", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: fixture.hiveId, templateId: fixture.templateId }),
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({
      deleted: false,
      archived: true,
      templateId: fixture.templateId,
    });
    expect(body.data.reason).toMatch(/run history/i);

    const [template] = await sql<{ active: boolean }[]>`
      SELECT active FROM pipeline_templates WHERE id = ${fixture.templateId}
    `;
    expect(template.active).toBe(false);
  });

  it("hard deletes templates with no run history", async () => {
    const ns = createFixtureNamespace("pipelines-api-delete");
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES (${ns.slug("hive")}, 'Procedure Delete Hive', 'digital')
      RETURNING id
    `;
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('ops-agent', 'Ops Agent', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;
    const created = await PUT(new Request("http://localhost/api/pipelines", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: hive.id,
        name: "Temporary Procedure",
        department: "operations",
        active: false,
        steps: [{ order: 1, name: "Draft step", roleSlug: "ops-agent", duty: "Draft the procedure." }],
      }),
    }));
    const createdBody = await created.json();

    const res = await DELETE(new Request("http://localhost/api/pipelines", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hiveId: hive.id, templateId: createdBody.data.id }),
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ deleted: true, archived: false, templateId: createdBody.data.id });

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM pipeline_templates WHERE id = ${createdBody.data.id}
    `;
    expect(rows).toHaveLength(0);
  });

  it("rejects approving procedures without execution-ready contracts", async () => {
    const ns = createFixtureNamespace("pipelines-api-invalid-contract");
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES (${ns.slug("hive")}, 'Procedure Contract Hive', 'digital')
      RETURNING id
    `;
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES ('ops-agent', 'Ops Agent', 'executor', 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;

    const missingFinalContract = await PUT(new Request("http://localhost/api/pipelines", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: hive.id,
        name: "Invalid Active Procedure",
        department: "operations",
        active: true,
        finalOutputContract: {},
        steps: [{ order: 1, name: "Do it", roleSlug: "ops-agent", duty: "Do the work." }],
      }),
    }));
    expect(missingFinalContract.status).toBe(400);
    await expect(missingFinalContract.json()).resolves.toMatchObject({
      error: expect.stringMatching(/finalOutputContract\.requiredFields/i),
    });

    const missingStepContract = await PUT(new Request("http://localhost/api/pipelines", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: hive.id,
        name: "Invalid Step Contract Procedure",
        department: "operations",
        active: true,
        steps: [{
          order: 1,
          name: "Do it",
          roleSlug: "ops-agent",
          duty: "Do the work.",
          outputContract: {},
        }],
      }),
    }));
    expect(missingStepContract.status).toBe(400);
    await expect(missingStepContract.json()).resolves.toMatchObject({
      error: expect.stringMatching(/steps\[0\]\.outputContract\.requiredFields/i),
    });
  });

  it("rejects missing role slugs before saving procedure steps", async () => {
    const ns = createFixtureNamespace("pipelines-api-missing-role");
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES (${ns.slug("hive")}, 'Procedure Validation Hive', 'digital')
      RETURNING id
    `;

    const res = await PUT(new Request("http://localhost/api/pipelines", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId: hive.id,
        name: "Invalid Procedure",
        department: "operations",
        active: true,
        steps: [{ order: 1, name: "Missing role", roleSlug: "missing-agent", duty: "This should fail." }],
      }),
    }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/roleSlug does not exist: missing-agent/i);
  });
});
