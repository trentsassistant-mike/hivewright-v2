import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import {
  QUALITY_DOCTOR_MODEL,
  applyQualityDoctorDiagnosis,
  maybeCreateQualityDoctorForRoleWindow,
  maybeCreateQualityDoctorForSignal,
  parseQualityDoctorDiagnosis,
} from "@/quality/doctor";

const HIVE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE}, 'quality-doctor', 'Quality Doctor', 'digital')
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES
      ('quality-role', 'Quality Role', 'executor', 'claude-code'),
      ('doctor', 'Doctor', 'system', 'ollama')
    ON CONFLICT (slug) DO NOTHING
  `;
});

async function seedCompletedTask(title = "Low quality task", completedDaysAgo = 0) {
  const [task] = await sql<{ id: string }[]>`
    INSERT INTO tasks (
      hive_id, assigned_to, created_by, status, title, brief,
      result_summary, completed_at
    )
    VALUES (
      ${HIVE}, 'quality-role', 'owner', 'completed', ${title}, 'Use the connector and produce a report.',
      'The result skipped the connector.', NOW() - (${completedDaysAgo} * INTERVAL '1 day')
    )
    RETURNING id
  `;
  await sql`
    INSERT INTO work_products (task_id, hive_id, role_slug, content, summary)
    VALUES (${task.id}, ${HIVE}, 'quality-role', 'Deliverable body', 'Deliverable summary')
  `;
  await sql`
    INSERT INTO task_logs (task_id, type, chunk)
    VALUES (${task.id}, 'stdout', 'Agent session log content')
  `;
  return task.id;
}

async function makeTaskReworked(taskId: string) {
  await sql`
    UPDATE tasks
    SET retry_count = 1,
        doctor_attempts = 1
    WHERE id = ${taskId}
  `;
}

describe("quality doctor triggers", () => {
  it("uses Sonnet 4.6 for quality-diagnosis tasks", () => {
    expect(QUALITY_DOCTOR_MODEL).toBe("auto");
  });

  it("creates a cheap quality-doctor task for explicit owner ratings <= 6", async () => {
    const taskId = await seedCompletedTask();

    const doctorTaskId = await maybeCreateQualityDoctorForSignal(sql, taskId, {
      source: "explicit_owner_feedback",
      signalType: "neutral",
      rating: 6,
      evidence: "owner rated task quality 6/10",
      confidence: 1,
    });

    expect(doctorTaskId).toBeTruthy();
    const [doctorTask] = await sql`
      SELECT brief, model_override FROM tasks WHERE id = ${doctorTaskId}
    `;
    expect(doctorTask.model_override).toBe(QUALITY_DOCTOR_MODEL);
    expect(doctorTask.brief as string).toContain("Use exactly one cause category");
    expect(doctorTask.brief as string).toContain("Agent session log content");
    expect(doctorTask.brief as string).toContain("owner rated task quality 6/10");
  });

  it("creates a quality-doctor task for strong negative implicit signals", async () => {
    const taskId = await seedCompletedTask();

    const doctorTaskId = await maybeCreateQualityDoctorForSignal(sql, taskId, {
      source: "implicit_ea",
      signalType: "negative",
      evidence: "that fix was wrong",
      confidence: 0.9,
    });

    expect(doctorTaskId).toBeTruthy();
  });

  it("reuses an active quality-doctor task instead of creating a duplicate", async () => {
    const taskId = await seedCompletedTask();
    const firstDoctorTaskId = await maybeCreateQualityDoctorForSignal(sql, taskId, {
      source: "implicit_ea",
      signalType: "negative",
      evidence: "that fix was wrong",
      confidence: 0.9,
    });
    expect(firstDoctorTaskId).toBeTruthy();

    await sql`
      UPDATE tasks
      SET status = 'active'
      WHERE id = ${firstDoctorTaskId}
    `;

    const secondDoctorTaskId = await maybeCreateQualityDoctorForSignal(sql, taskId, {
      source: "implicit_ea",
      signalType: "negative",
      evidence: "same low quality window observed again",
      confidence: 0.9,
    });

    expect(secondDoctorTaskId).toBe(firstDoctorTaskId);
    const [count] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM tasks
      WHERE parent_task_id = ${taskId}
        AND assigned_to = 'doctor'
        AND created_by = 'quality-doctor'
    `;
    expect(count.count).toBe(1);
  });

  it("does not recreate a quality-doctor task after a prior terminal attempt", async () => {
    const taskId = await seedCompletedTask();
    const firstDoctorTaskId = await maybeCreateQualityDoctorForSignal(sql, taskId, {
      source: "implicit_ea",
      signalType: "negative",
      evidence: "that fix was wrong",
      confidence: 0.9,
    });
    expect(firstDoctorTaskId).toBeTruthy();

    await sql`
      UPDATE tasks
      SET status = 'unresolvable',
          failure_reason = 'Auto model routing unavailable'
      WHERE id = ${firstDoctorTaskId}
    `;

    const secondDoctorTaskId = await maybeCreateQualityDoctorForSignal(sql, taskId, {
      source: "implicit_ea",
      signalType: "negative",
      evidence: "same low quality window observed again",
      confidence: 0.9,
    });

    expect(secondDoctorTaskId).toBe(firstDoctorTaskId);
    const [count] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM tasks
      WHERE parent_task_id = ${taskId}
        AND assigned_to = 'doctor'
        AND created_by = 'quality-doctor'
    `;
    expect(count.count).toBe(1);
  });

  it("creates a quality-doctor task when a 5-task role window drops more than 0.1 below floor", async () => {
    for (let i = 0; i < 5; i++) {
      const taskId = await seedCompletedTask(`Bad ${i}`, 5 - i);
      await sql`
        INSERT INTO task_quality_signals (task_id, hive_id, signal_type, source, evidence, confidence, rating)
        VALUES (${taskId}, ${HIVE}, 'negative', 'explicit_owner_feedback', 'bad', 1, 2)
      `;
    }

    const doctorTaskId = await maybeCreateQualityDoctorForRoleWindow(sql, HIVE, "quality-role");

    expect(doctorTaskId).toBeTruthy();
  });

  it("does not create a quality-doctor task when only older aggregate history is below floor", async () => {
    for (let i = 0; i < 20; i++) {
      const taskId = await seedCompletedTask(`Older bad ${i}`, 30 - i);
      await makeTaskReworked(taskId);
      await sql`
        INSERT INTO task_quality_signals (task_id, hive_id, signal_type, source, evidence, confidence, rating)
        VALUES (${taskId}, ${HIVE}, 'negative', 'explicit_owner_feedback', 'bad', 1, 1)
      `;
    }
    for (let i = 0; i < 5; i++) {
      const taskId = await seedCompletedTask(`Recent good ${i}`, 5 - i);
      await sql`
        INSERT INTO task_quality_signals (task_id, hive_id, signal_type, source, evidence, confidence, rating)
        VALUES (${taskId}, ${HIVE}, 'positive', 'explicit_owner_feedback', 'good', 1, 9)
      `;
    }

    const doctorTaskId = await maybeCreateQualityDoctorForRoleWindow(sql, HIVE, "quality-role");

    expect(doctorTaskId).toBeNull();
  });
});

describe("quality doctor routing", () => {
  it("parses exactly one approved cause category", () => {
    const parsed = parseQualityDoctorDiagnosis([
      "```json",
      JSON.stringify({
        cause: "missing_tool_connector_credential",
        details: "The agent lacked access.",
        recommendation: "Connect the account.",
        options: [
          {
            key: "existing-codex-subscription-auth",
            label: "Use existing Codex subscription auth",
            consequence: "Reuses the owner's already-paid auth path if supported.",
            response: "approved",
          },
        ],
      }),
      "```",
    ].join("\n"));

    expect(parsed?.cause).toBe("missing_tool_connector_credential");
    expect(parsed?.options?.[0]).toMatchObject({
      key: "existing-codex-subscription-auth",
      label: "Use existing Codex subscription auth",
    });
    expect(parseQualityDoctorDiagnosis("```json\n{\"cause\":\"other\",\"details\":\"x\",\"recommendation\":\"y\"}\n```")).toBeNull();
  });

  it("routes missing-skill to a Tier 2 decision and governed skill candidate without marking parked ideas done", async () => {
    const taskId = await seedCompletedTask();
    await sql`
      INSERT INTO hive_ideas (hive_id, title, body, created_by, status)
      VALUES
        (${HIVE}, '2dd4b249 skill future work', 'future skill', 'owner', 'open'),
        (${HIVE}, 'd96e8c31 internet skill future work', 'future skill', 'owner', 'open')
    `;

    await applyQualityDoctorDiagnosis(sql, taskId, {
      cause: "missing_skill",
      details: "The role did not know the procedure.",
      recommendation: "Propose sourcing a skill.",
    });

    const [decision] = await sql`
      SELECT priority, status, context FROM decisions
      WHERE task_id = ${taskId}
    `;
    expect(decision.priority).toBe("normal");
    expect(decision.status).toBe("pending");
    expect(decision.context as string).toContain("2dd4b249");

    const ideas = await sql<{ status: string }[]>`
      SELECT status FROM hive_ideas WHERE hive_id = ${HIVE} ORDER BY title
    `;
    expect(ideas.map((idea) => idea.status)).toEqual(["open", "open"]);

    const [skillTasks] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM tasks
      WHERE hive_id = ${HIVE}
        AND title ILIKE '%skill%'
        AND created_by = 'quality-doctor'
    `;
    expect(skillTasks.count).toBe(0);

    const [candidate] = await sql<{ role_slug: string; slug: string; evidence: unknown[] | string }[]>`
      SELECT role_slug, slug, evidence
      FROM skill_drafts
      WHERE hive_id = ${HIVE}
        AND role_slug = 'quality-role'
    `;
    const evidence = typeof candidate.evidence === "string"
      ? JSON.parse(candidate.evidence) as unknown[]
      : candidate.evidence;
    expect(candidate.role_slug).toBe("quality-role");
    expect(candidate.slug).toBe("quality-role-failure-pattern-skill-improvement");
    expect(evidence).toHaveLength(1);
  });

  it("routes missing tool/connector/credential gaps to a Tier 2 decision without auto-remediation", async () => {
    const taskId = await seedCompletedTask();

    await applyQualityDoctorDiagnosis(sql, taskId, {
      cause: "missing_tool_connector_credential",
      details: "The role could not access the source account.",
      recommendation: "Ask the owner to connect the account before retrying.",
      options: [
        {
          key: "existing-codex-subscription-auth",
          label: "Use existing Codex subscription auth",
          consequence: "Reuses an already-paid owner subscription if technically supported.",
          response: "approved",
        },
        {
          key: "new-openai-api-key",
          label: "Provide a new OpenAI API key",
          consequence: "Requires a separate credential and may add API billing.",
          response: "approved",
        },
        {
          key: "switch-installed-image-path",
          label: "Use another installed image path",
          consequence: "Avoids new OpenAI credential work if a supported connector is already available.",
          response: "approved",
        },
        {
          key: "defer-image-generation",
          label: "Defer image generation",
          consequence: "Leaves image work blocked until an auth path is chosen.",
          response: "rejected",
        },
      ],
    });

    const [decision] = await sql`
      SELECT priority, status, context, recommendation, options, kind
      FROM decisions
      WHERE task_id = ${taskId}
    `;
    expect(decision.priority).toBe("normal");
    expect(decision.status).toBe("pending");
    expect(decision.kind).toBe("quality_doctor_recommendation");
    expect(decision.context as string).toContain("missing_tool_connector_credential");
    expect(decision.recommendation as string).toContain("connect the account");
    expect((decision.options as Array<{ key: string }>).map((option) => option.key)).toEqual([
      "existing-codex-subscription-auth",
      "new-openai-api-key",
      "switch-installed-image-path",
      "defer-image-generation",
    ]);

    const [autoRemediationTasks] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM tasks
      WHERE hive_id = ${HIVE}
        AND created_by = 'quality-doctor'
        AND (
          title ILIKE '%connector%'
          OR title ILIKE '%credential%'
          OR title ILIKE '%install%'
        )
    `;
    expect(autoRemediationTasks.count).toBe(0);
  });

  it("routes wrong-model through sweeper guardrails and wrong-role/brief to supervisor recommendation", async () => {
    const taskId = await seedCompletedTask();

    await applyQualityDoctorDiagnosis(sql, taskId, {
      cause: "wrong_model",
      details: "The answer was generic despite enough context.",
      recommendation: "Try a stronger model.",
    });
    await applyQualityDoctorDiagnosis(sql, taskId, {
      cause: "wrong_role_or_brief",
      details: "The role did not match the task.",
      recommendation: "Split and reroute.",
    });

    const decisions = await sql<{ recommendation: string }[]>`
      SELECT recommendation FROM decisions
      WHERE task_id = ${taskId}
      ORDER BY created_at ASC
    `;
    expect(decisions[0].recommendation).toContain("model-efficiency sweeper guardrails");
    expect(decisions[1].recommendation).toContain("supervisor");
  });
});
