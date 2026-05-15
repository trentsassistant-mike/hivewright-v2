import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import {
  parseDoctorDiagnosis,
  applyDoctorDiagnosis,
  escalateMalformedDiagnosis,
  createDoctorTask,
} from "@/doctor";

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('dl-biz', 'Doctor Loop Test', 'digital')
    RETURNING id
  `;
  bizId = biz.id;

  // Two roles: the role that "failed" and the role the doctor might reassign to.
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dl-original-role', 'Original', 'executor', 'claude-code'),
           ('dl-reassign-role', 'Reassign Target', 'executor', 'claude-code'),
           ('doctor', 'Doctor', 'system', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

async function makeFailedTask(): Promise<{ id: string }> {
  const [task] = await sql`
    INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief,
                       status, failure_reason, acceptance_criteria)
    VALUES (
      ${bizId}, 'dl-original-role', 'owner',
      'dl-original-task', 'Do the thing',
      'failed', 'Module not found',
      'Thing is done'
    )
    RETURNING id
  `;
  return { id: task.id };
}

describe("doctor loop — rewrite_brief", () => {
  it("end-to-end: parse diagnosis → apply → parent task status+brief updated", async () => {
    const failed = await makeFailedTask();
    const doctorTask = await createDoctorTask(sql, failed.id);
    expect(doctorTask).not.toBeNull();

    const doctorOutput = [
      "Analysis: brief was missing the specific endpoint.",
      "```json",
      JSON.stringify({
        action: "rewrite_brief",
        details: "Added endpoint URL.",
        newBrief: "Do the thing. Endpoint: https://api.example.com/v1/things",
      }),
      "```",
    ].join("\n");

    const parsed = parseDoctorDiagnosis(doctorOutput);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) await applyDoctorDiagnosis(sql, failed.id, parsed.diagnosis);

    const [after] = await sql`
      SELECT status, brief, doctor_attempts, retry_count FROM tasks WHERE id = ${failed.id}
    `;
    expect(after.status).toBe("pending");
    expect(after.brief).toContain("api.example.com");
    expect(after.doctor_attempts).toBe(1);
    expect(after.retry_count).toBe(0);
  });
});

describe("doctor loop — reassign", () => {
  it("reassigns the parent task to a different role", async () => {
    const failed = await makeFailedTask();
    await createDoctorTask(sql, failed.id);

    const output =
      "```json\n" +
      JSON.stringify({
        action: "reassign",
        details: "Wrong role — should be a data task.",
        newRole: "dl-reassign-role",
      }) +
      "\n```";
    const parsed = parseDoctorDiagnosis(output);
    if (parsed.ok) await applyDoctorDiagnosis(sql, failed.id, parsed.diagnosis);

    const [after] = await sql`
      SELECT status, assigned_to, doctor_attempts FROM tasks WHERE id = ${failed.id}
    `;
    expect(after.status).toBe("pending");
    expect(after.assigned_to).toBe("dl-reassign-role");
    expect(after.doctor_attempts).toBe(1);
  });
});

describe("doctor loop — split_task", () => {
  it("cancels parent, inserts subtasks with parent_task_id set", async () => {
    const failed = await makeFailedTask();
    await createDoctorTask(sql, failed.id);

    const output =
      "```json\n" +
      JSON.stringify({
        action: "split_task",
        details: "Too complex — split into discovery + implementation.",
        subTasks: [
          { title: "dl-sub-discovery", brief: "Research X", assignedTo: "dl-original-role" },
          { title: "dl-sub-implement", brief: "Implement Y", assignedTo: "dl-reassign-role" },
        ],
      }) +
      "\n```";
    const parsed = parseDoctorDiagnosis(output);
    if (parsed.ok) await applyDoctorDiagnosis(sql, failed.id, parsed.diagnosis);

    const [parent] = await sql`SELECT status FROM tasks WHERE id = ${failed.id}`;
    expect(parent.status).toBe("cancelled");

    const subs = await sql`
      SELECT title, assigned_to, parent_task_id FROM tasks
      WHERE parent_task_id = ${failed.id} AND assigned_to != 'doctor'
      ORDER BY title
    `;
    expect(subs.length).toBe(2);
    expect(subs[0].title).toBe("dl-sub-discovery");
    expect(subs[0].assigned_to).toBe("dl-original-role");
    expect(subs[1].title).toBe("dl-sub-implement");
    expect(subs[1].assigned_to).toBe("dl-reassign-role");
  });
});

describe("doctor loop — fix_environment", () => {
  it("blocks parent + inserts infrastructure task", async () => {
    const failed = await makeFailedTask();
    await createDoctorTask(sql, failed.id);

    const output =
      "```json\n" +
      JSON.stringify({
        action: "fix_environment",
        details: "newbook-sdk package is not installed in workspace.",
      }) +
      "\n```";
    const parsed = parseDoctorDiagnosis(output);
    if (parsed.ok) await applyDoctorDiagnosis(sql, failed.id, parsed.diagnosis);

    const [parent] = await sql`
      SELECT status, doctor_attempts FROM tasks WHERE id = ${failed.id}
    `;
    expect(parent.status).toBe("blocked");
    expect(parent.doctor_attempts).toBe(1);

    const envFixTasks = await sql`
      SELECT title, brief FROM tasks
      WHERE assigned_to = 'doctor' AND title LIKE 'Fix environment for: %' AND hive_id = ${bizId}
    `;
    expect(envFixTasks.length).toBe(1);
    expect(envFixTasks[0].brief).toContain("newbook-sdk");
  });
});

describe("doctor loop — escalate", () => {
  it("marks parent unresolvable + creates a decision row", async () => {
    const failed = await makeFailedTask();
    await createDoctorTask(sql, failed.id);

    const output =
      "```json\n" +
      JSON.stringify({
        action: "escalate",
        details: "Ambiguous requirements — need owner to clarify which CRM.",
        decisionTitle: "Which CRM for customer export?",
        decisionContext: "The task said 'export customers' but we have both NewBook and Pipedrive.",
      }) +
      "\n```";
    const parsed = parseDoctorDiagnosis(output);
    if (parsed.ok) await applyDoctorDiagnosis(sql, failed.id, parsed.diagnosis);

    const [parent] = await sql`SELECT status FROM tasks WHERE id = ${failed.id}`;
    expect(parent.status).toBe("unresolvable");

    const decisions = await sql`
      SELECT title, priority, status FROM decisions
      WHERE hive_id = ${bizId} ORDER BY created_at DESC LIMIT 1
    `;
    expect(decisions.length).toBe(1);
    expect(decisions[0].title).toBe("Which CRM for customer export?");
    expect(decisions[0].priority).toBe("urgent");
    // EA-first pipeline: doctor escalations land in 'ea_review' first.
    expect(decisions[0].status).toBe("ea_review");
  });
});

describe("doctor loop — parse failure escalation", () => {
  it("no JSON block → unresolvable + decision with raw output in context", async () => {
    const failed = await makeFailedTask();
    const rawOutput = "I think we should rewrite the brief, but I couldn't get the structured output right.";
    const parsed = parseDoctorDiagnosis(rawOutput);
    expect(parsed.ok).toBe(false);

    if (!parsed.ok) {
      await escalateMalformedDiagnosis(sql, failed.id, parsed.reason, rawOutput);
    }

    const [parent] = await sql`
      SELECT status, failure_reason FROM tasks WHERE id = ${failed.id}
    `;
    expect(parent.status).toBe("unresolvable");
    expect(parent.failure_reason).toContain("parse failure");

    const decisions = await sql`
      SELECT title, context FROM decisions WHERE hive_id = ${bizId}
    `;
    expect(decisions.length).toBe(1);
    expect(decisions[0].title).toContain("malformed diagnosis");
    expect(decisions[0].context).toContain(rawOutput);
    expect(decisions[0].context).toContain("No ```json block found");
  });

  it("malformed JSON → unresolvable + decision", async () => {
    const failed = await makeFailedTask();
    const rawOutput = "```json\n{action: not-quoted, details: 'x'}\n```";
    const parsed = parseDoctorDiagnosis(rawOutput);
    expect(parsed.ok).toBe(false);

    if (!parsed.ok) {
      await escalateMalformedDiagnosis(sql, failed.id, parsed.reason, rawOutput);
    }

    const [parent] = await sql`SELECT status FROM tasks WHERE id = ${failed.id}`;
    expect(parent.status).toBe("unresolvable");
  });

  it("preserves project context via task_id when escalating a malformed diagnosis on a project-scoped task", async () => {
    // Regression: previously the malformed-diagnosis decision dropped the
    // originating task linkage, so EA / dispatcher / dashboard could not
    // resolve the project workspace from the resulting decision.
    const [project] = await sql`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES (${bizId}, 'dl-malformed-project', 'DL Malformed Project', '/tmp/dl/malformed')
      RETURNING id
    `;
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, description, project_id)
      VALUES (${bizId}, 'Goal for malformed', 'desc', ${project.id})
      RETURNING id
    `;
    const [failed] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief,
                         status, failure_reason, project_id, goal_id)
      VALUES (
        ${bizId}, 'dl-original-role', 'owner',
        'dl-malformed-scoped', 'Do the thing',
        'failed', 'something broke',
        ${project.id}, ${goal.id}
      )
      RETURNING id
    `;

    const rawOutput = "I'm not going to bother with structured output.";
    const parsed = parseDoctorDiagnosis(rawOutput);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      await escalateMalformedDiagnosis(sql, failed.id, parsed.reason, rawOutput);
    }

    const [decision] = await sql<{
      id: string;
      hive_id: string;
      goal_id: string | null;
      task_id: string | null;
    }[]>`
      SELECT id, hive_id, goal_id, task_id FROM decisions WHERE hive_id = ${bizId}
    `;
    expect(decision.task_id).toBe(failed.id);
    expect(decision.goal_id).toBe(goal.id);
    expect(decision.hive_id).toBe(bizId);

    const [scoped] = await sql<{ project_id: string | null }[]>`
      SELECT t.project_id
      FROM decisions d JOIN tasks t ON t.id = d.task_id
      WHERE d.id = ${decision.id}
    `;
    expect(scoped.project_id).toBe(project.id);
  });

  it("valid JSON but unknown action → unresolvable + decision", async () => {
    const failed = await makeFailedTask();
    const rawOutput =
      "```json\n" + JSON.stringify({ action: "nuke_it", details: "just kidding" }) + "\n```";
    const parsed = parseDoctorDiagnosis(rawOutput);
    expect(parsed.ok).toBe(false);

    if (!parsed.ok) {
      await escalateMalformedDiagnosis(sql, failed.id, parsed.reason, rawOutput);
    }

    const [parent] = await sql`SELECT status FROM tasks WHERE id = ${failed.id}`;
    expect(parent.status).toBe("unresolvable");

    const decisions = await sql`SELECT context FROM decisions WHERE hive_id = ${bizId}`;
    expect(decisions[0].context).toContain("Unknown action: nuke_it");
  });
});

describe("doctor loop — parent task disappears", () => {
  it("escalateMalformedDiagnosis logs + returns when parent is gone", async () => {
    // No failed-task insert — pass a random UUID.
    await escalateMalformedDiagnosis(
      sql,
      "00000000-0000-0000-0000-000000000000",
      "some reason",
      "some output",
    );
    // No decision should have been created for the missing parent.
    const decisions = await sql`SELECT count(*) FROM decisions`;
    expect(Number(decisions[0].count)).toBe(0);
  });
});
