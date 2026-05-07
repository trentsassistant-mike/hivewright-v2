import { beforeEach, describe, expect, it } from "vitest";
import { notifyGoalSupervisorOfQaFailure } from "@/dispatcher/qa-router";
import { createDoctorTask } from "@/doctor";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [hive] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('loop-guard-hive', 'Loop Guard Hive', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES
      ('loop-executor', 'Loop Executor', 'executor', 'codex'),
      ('doctor', 'Doctor', 'system', 'codex'),
      ('goal-supervisor', 'Goal Supervisor', 'system', 'codex')
    ON CONFLICT (slug) DO UPDATE
    SET name = EXCLUDED.name,
        type = EXCLUDED.type,
        adapter_type = EXCLUDED.adapter_type,
        active = true
  `;
});

describe("recovery loop guards", () => {
  it("reuses an existing active doctor task for the same failed parent", async () => {
    const [parent] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, failure_reason)
      VALUES (${hiveId}, 'loop-executor', 'owner', 'loop failed parent', 'Do work', 'failed', 'agent failed')
      RETURNING id
    `;
    const [existingDoctor] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id)
      VALUES (${hiveId}, 'doctor', 'dispatcher', '[Doctor] Diagnose: loop failed parent', 'diagnose once', 'active', ${parent.id})
      RETURNING id
    `;

    const doctorTask = await createDoctorTask(sql, parent.id as string);

    const rows = await sql`
      SELECT id
      FROM tasks
      WHERE parent_task_id = ${parent.id}
        AND assigned_to = 'doctor'
        AND status IN ('pending', 'active', 'running', 'claimed', 'in_review')
      ORDER BY created_at ASC
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(existingDoctor.id);
    expect(doctorTask?.id).toBe(existingDoctor.id);
  });

  it("reuses an existing active QA replan task for the same failed parent", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, description, status)
      VALUES (${hiveId}, 'Loop Guard Goal', 'Guard repeated QA replans', 'active')
      RETURNING id
    `;
    const [parent] = await sql`
      INSERT INTO tasks (
        hive_id, goal_id, assigned_to, created_by, title, brief, status,
        failure_reason, retry_count, sprint_number
      )
      VALUES (
        ${hiveId}, ${goal.id}, 'loop-executor', 'goal-supervisor',
        'loop qa failed parent', 'Do goal work', 'failed',
        'QA retry cap reached', 2, 4
      )
      RETURNING id
    `;
    const [existingReplan] = await sql`
      INSERT INTO tasks (
        hive_id, goal_id, assigned_to, created_by, title, brief, status,
        parent_task_id, sprint_number
      )
      VALUES (
        ${hiveId}, ${goal.id}, 'goal-supervisor', 'dispatcher',
        '[Replan] QA failed repeatedly: loop qa failed parent',
        'already replanning', 'pending', ${parent.id}, 4
      )
      RETURNING id
    `;

    await notifyGoalSupervisorOfQaFailure(sql, parent.id as string, "Repeated QA feedback");

    const rows = await sql`
      SELECT id
      FROM tasks
      WHERE parent_task_id = ${parent.id}
        AND assigned_to = 'goal-supervisor'
        AND title LIKE '[Replan] QA failed repeatedly:%'
        AND status IN ('pending', 'active', 'running', 'claimed', 'in_review')
      ORDER BY created_at ASC
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(existingReplan.id);
  });
});
