import { describe, it, expect, beforeEach } from "vitest";
import { POST as respondToDecision } from "@/app/api/decisions/[id]/respond/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;
let goalId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type)
    VALUES ('learning-gate-approval', 'Learning Gate Approval', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;

  const [goal] = await sql<{ id: string }[]>`
    INSERT INTO goals (hive_id, title, status)
    VALUES (${hiveId}, 'Reusable close workflow', 'achieved')
    RETURNING id
  `;
  goalId = goal.id;
});

function respondReq(decisionId: string, body: object) {
  return respondToDecision(
    new Request(`http://localhost/api/decisions/${decisionId}/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: decisionId }) },
  );
}

async function createLearningGateDecision(category: string, followup: Record<string, unknown>) {
  const [decision] = await sql<{ id: string }[]>`
    INSERT INTO decisions (
      hive_id,
      goal_id,
      title,
      context,
      recommendation,
      options,
      priority,
      status,
      kind,
      route_metadata
    )
    VALUES (
      ${hiveId},
      ${goalId},
      ${`${category}: review reusable learning`},
      ${`Learning gate category: ${category}`},
      ${String(followup.action ?? "Review this reusable learning candidate.")},
      ${sql.json([
        { key: "approve-followup", label: "Approve follow-up", response: "approved" },
        { key: "reject-followup", label: "Reject follow-up", response: "rejected" },
      ])},
      'normal',
      'pending',
      'learning_gate_followup',
      ${sql.json({
        learningGateFollowup: {
          category,
          rationale: "This worked and may be reusable.",
          summary: "Goal completed with reusable evidence.",
          ...followup,
        },
      })}
    )
    RETURNING id
  `;
  return decision.id;
}

describe("POST /api/decisions/[id]/respond — learning gate follow-up approval", () => {
  it("creates a standing instruction only when a policy candidate is explicitly approved", async () => {
    const decisionId = await createLearningGateDecision("policy_candidate", {
      action: "Require owner approval before publishing public launch copy.",
      affectedDepartments: ["marketing", "ops"],
    });

    const before = await sql`SELECT id FROM standing_instructions WHERE hive_id = ${hiveId}`;
    expect(before).toHaveLength(0);

    const res = await respondReq(decisionId, {
      response: "approved",
      selectedOptionKey: "approve-followup",
      comment: "Make this a rule.",
    });

    expect(res.status).toBe(200);

    const [instruction] = await sql<{
      content: string;
      affected_departments: string[];
      confidence: number;
      review_at: Date | null;
    }[]>`
      SELECT content, affected_departments, confidence, review_at
      FROM standing_instructions
      WHERE hive_id = ${hiveId}
    `;
    expect(instruction.content).toBe("Require owner approval before publishing public launch copy.");
    expect(instruction.affected_departments).toEqual(["marketing", "ops"]);
    expect(instruction.confidence).toBe(1);
    expect(instruction.review_at).toBeTruthy();

    const [decision] = await sql<{ route_metadata: Record<string, unknown> }[]>`
      SELECT route_metadata FROM decisions WHERE id = ${decisionId}
    `;
    expect(decision.route_metadata.learningGateApproval).toMatchObject({
      status: "applied",
      category: "policy_candidate",
      assetType: "standing_instruction",
    });
  });

  it("reposting approved learning-gate decisions does not duplicate side effects or mutate responses", async () => {
    const policyDecisionId = await createLearningGateDecision("policy_candidate", {
      action: "Require owner approval before changing production launch scope.",
      affectedDepartments: ["ops"],
    });
    const pipelineDecisionId = await createLearningGateDecision("pipeline_candidate", {
      action: "Create a reusable launch-scope check.",
      pipeline: {
        slug: "launch-scope-check",
        name: "Launch Scope Check",
        department: "ops",
        steps: [
          {
            slug: "confirm-scope",
            name: "Confirm scope",
            roleSlug: "goal-supervisor",
            duty: "Confirm scope, constraints, and owner approval.",
          },
        ],
      },
    });
    const updateDecisionId = await createLearningGateDecision("update_existing", {
      action: "Update the launch-scope policy with a rollback checklist.",
    });

    for (const decisionId of [policyDecisionId, pipelineDecisionId, updateDecisionId]) {
      const first = await respondReq(decisionId, {
        response: "approved",
        selectedOptionKey: "approve-followup",
      });
      expect(first.status).toBe(200);

      const duplicate = await respondReq(decisionId, {
        response: "approved",
        selectedOptionKey: "approve-followup",
      });
      expect([200, 409]).toContain(duplicate.status);
    }

    const standing = await sql<{ id: string }[]>`
      SELECT id FROM standing_instructions WHERE hive_id = ${hiveId}
    `;
    expect(standing).toHaveLength(1);

    const pipelines = await sql<{ id: string }[]>`
      SELECT id FROM pipeline_templates WHERE hive_id = ${hiveId}
    `;
    expect(pipelines).toHaveLength(1);

    const followups = await sql<{ id: string }[]>`
      SELECT id
      FROM decisions
      WHERE hive_id = ${hiveId}
        AND kind = 'learning_gate_followup_review'
    `;
    expect(followups).toHaveLength(1);

    const approvals = await sql<{ route_metadata: Record<string, unknown> }[]>`
      SELECT route_metadata
      FROM decisions
      WHERE id IN (${policyDecisionId}, ${pipelineDecisionId}, ${updateDecisionId})
      ORDER BY id
    `;
    expect(approvals.map((row) => row.route_metadata.learningGateApproval)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "applied", assetType: "standing_instruction", assetId: standing[0].id }),
        expect.objectContaining({ status: "applied", assetType: "pipeline_template", assetId: pipelines[0].id }),
        expect.objectContaining({ status: "review_followup_created", followupDecisionId: followups[0].id }),
      ]),
    );

    const responses = await sql<{ owner_response: string | null }[]>`
      SELECT owner_response
      FROM decisions
      WHERE id IN (${policyDecisionId}, ${pipelineDecisionId}, ${updateDecisionId})
    `;
    expect(responses.map((row) => row.owner_response)).toEqual(
      expect.arrayContaining(["approved", "approved", "approved"]),
    );
  });

  it("rejects attempts to change an already approved learning-gate follow-up", async () => {
    const decisionId = await createLearningGateDecision("policy_candidate", {
      action: "Require owner approval before changing production launch scope.",
      affectedDepartments: ["ops"],
    });

    expect((await respondReq(decisionId, {
      response: "approved",
      selectedOptionKey: "approve-followup",
    })).status).toBe(200);

    const reject = await respondReq(decisionId, {
      response: "rejected",
      selectedOptionKey: "reject-followup",
      comment: "Changed my mind.",
    });

    expect(reject.status).toBe(409);
    const body = await reject.json();
    expect(body.error).toMatch(/already.*resolved/i);

    const [decision] = await sql<{ status: string; owner_response: string | null }[]>`
      SELECT status, owner_response
      FROM decisions
      WHERE id = ${decisionId}
    `;
    expect(decision).toMatchObject({
      status: "resolved",
      owner_response: "approved",
    });

    const standing = await sql<{ id: string }[]>`
      SELECT id
      FROM standing_instructions
      WHERE hive_id = ${hiveId}
    `;
    expect(standing).toHaveLength(1);
  });

  it("rejecting a learning-gate policy candidate leaves future behavior unchanged", async () => {
    const decisionId = await createLearningGateDecision("policy_candidate", {
      action: "Never launch without a compliance review.",
    });

    const res = await respondReq(decisionId, {
      response: "rejected",
      selectedOptionKey: "reject-followup",
      comment: "Do not make this reusable.",
    });

    expect(res.status).toBe(200);

    const standing = await sql`
      SELECT id FROM standing_instructions WHERE hive_id = ${hiveId}
    `;
    const pipelines = await sql`
      SELECT id FROM pipeline_templates WHERE hive_id = ${hiveId}
    `;
    expect(standing).toHaveLength(0);
    expect(pipelines).toHaveLength(0);
  });

  it("activates a hive pipeline template when an approved pipeline candidate has structured steps", async () => {
    const decisionId = await createLearningGateDecision("pipeline_candidate", {
      action: "Create a reusable launch-readiness procedure.",
      pipeline: {
        slug: "launch-readiness",
        name: "Launch Readiness",
        department: "marketing",
        description: "Owner-approved launch readiness process.",
        steps: [
          {
            slug: "brief",
            name: "Confirm launch brief",
            roleSlug: "goal-supervisor",
            duty: "Confirm launch scope, risk, and owner constraints.",
            acceptanceCriteria: "Brief includes scope, risks, and owner constraints.",
            outputContract: { requiredFields: ["summary", "risks"] },
          },
          {
            slug: "verify",
            name: "Verify launch evidence",
            roleSlug: "qa",
            duty: "Verify artifacts and tests before launch handoff.",
            acceptanceCriteria: "Evidence cites artifacts and verification results.",
            outputContract: { requiredFields: ["evidence", "verdict"] },
            qaRequired: true,
          },
        ],
      },
    });

    const res = await respondReq(decisionId, {
      response: "approved",
      selectedOptionKey: "approve-followup",
    });

    expect(res.status).toBe(200);

    const [template] = await sql<{
      id: string;
      scope: string;
      slug: string;
      name: string;
      department: string;
      active: boolean;
    }[]>`
      SELECT id, scope, slug, name, department, active
      FROM pipeline_templates
      WHERE hive_id = ${hiveId}
    `;
    expect(template).toMatchObject({
      scope: "hive",
      slug: "launch-readiness",
      name: "Launch Readiness",
      department: "marketing",
      active: true,
    });

    const steps = await sql<{ step_order: number; slug: string; role_slug: string; qa_required: boolean }[]>`
      SELECT step_order, slug, role_slug, qa_required
      FROM pipeline_steps
      WHERE template_id = ${template.id}
      ORDER BY step_order ASC
    `;
    expect(steps).toEqual([
      { step_order: 1, slug: "brief", role_slug: "goal-supervisor", qa_required: false },
      { step_order: 2, slug: "verify", role_slug: "qa", qa_required: true },
    ]);
  });

  it("approving an under-specified pipeline candidate records that more detail is needed", async () => {
    const decisionId = await createLearningGateDecision("pipeline_candidate", {
      action: "Maybe create a launch pipeline.",
    });

    const res = await respondReq(decisionId, {
      response: "approved",
      selectedOptionKey: "approve-followup",
    });

    expect(res.status).toBe(200);

    const templates = await sql`
      SELECT id FROM pipeline_templates WHERE hive_id = ${hiveId}
    `;
    expect(templates).toHaveLength(0);

    const [decision] = await sql<{ route_metadata: Record<string, unknown> }[]>`
      SELECT route_metadata FROM decisions WHERE id = ${decisionId}
    `;
    expect(decision.route_metadata.learningGateApproval).toMatchObject({
      status: "needs_detail",
      category: "pipeline_candidate",
      reason: expect.stringContaining("structured pipeline steps"),
    });
  });

  it("approving a pipeline candidate with an unknown role records needs-detail without creating a template", async () => {
    const decisionId = await createLearningGateDecision("pipeline_candidate", {
      action: "Create a reusable role-specific launch procedure.",
      pipeline: {
        slug: "role-specific-launch",
        name: "Role Specific Launch",
        department: "ops",
        steps: [
          {
            slug: "missing-role-step",
            name: "Missing role step",
            roleSlug: "missing-learning-gate-role",
            duty: "Run the launch procedure with a role that is not provisioned.",
          },
        ],
      },
    });

    const res = await respondReq(decisionId, {
      response: "approved",
      selectedOptionKey: "approve-followup",
    });

    expect(res.status).toBe(200);

    const templates = await sql`
      SELECT id FROM pipeline_templates WHERE hive_id = ${hiveId}
    `;
    expect(templates).toHaveLength(0);

    const [decision] = await sql<{ status: string; route_metadata: Record<string, unknown> }[]>`
      SELECT status, route_metadata FROM decisions WHERE id = ${decisionId}
    `;
    expect(decision.status).toBe("resolved");
    expect(decision.route_metadata.learningGateApproval).toMatchObject({
      status: "needs_detail",
      category: "pipeline_candidate",
      reason: expect.stringContaining("missing-learning-gate-role"),
    });
  });

  it("approving an update-existing candidate creates a separate review follow-up without mutating governed assets", async () => {
    const decisionId = await createLearningGateDecision("update_existing", {
      action: "Update the launch-readiness policy to require an accessibility checklist.",
    });

    const res = await respondReq(decisionId, {
      response: "approved",
      selectedOptionKey: "approve-followup",
      comment: "Review this update separately.",
    });

    expect(res.status).toBe(200);

    const followups = await sql<{ kind: string; status: string; context: string }[]>`
      SELECT kind, status, context
      FROM decisions
      WHERE hive_id = ${hiveId}
        AND id <> ${decisionId}
      ORDER BY created_at ASC
    `;
    expect(followups).toHaveLength(1);
    expect(followups[0]).toMatchObject({
      kind: "learning_gate_followup_review",
      status: "pending",
    });
    expect(followups[0].context).toContain("Existing governed assets were not changed");

    const standing = await sql`
      SELECT id FROM standing_instructions WHERE hive_id = ${hiveId}
    `;
    const pipelines = await sql`
      SELECT id FROM pipeline_templates WHERE hive_id = ${hiveId}
    `;
    expect(standing).toHaveLength(0);
    expect(pipelines).toHaveLength(0);

    const [decision] = await sql<{ route_metadata: Record<string, unknown> }[]>`
      SELECT route_metadata FROM decisions WHERE id = ${decisionId}
    `;
    expect(decision.route_metadata.learningGateApproval).toMatchObject({
      status: "review_followup_created",
      category: "update_existing",
      followupDecisionKind: "learning_gate_followup_review",
    });
  });
});
