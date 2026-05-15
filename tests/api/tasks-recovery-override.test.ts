import { beforeEach, describe, expect, it } from "vitest";
import { POST as createTask } from "@/app/api/tasks/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;

async function createExhaustedFamily(title: string) {
  const [goal] = await sql<{ id: string }[]>`
    INSERT INTO goals (hive_id, title, status)
    VALUES (${hiveId}, ${`${title} goal`}, 'active')
    RETURNING id
  `;
  const [root] = await sql<{ id: string }[]>`
    INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, title, brief, status)
    VALUES (${hiveId}, ${goal.id}, 'dev-agent', 'goal-supervisor', ${title}, 'Original work', 'failed')
    RETURNING id
  `;
  for (let i = 1; i <= 3; i += 1) {
    await sql`
      INSERT INTO tasks (hive_id, goal_id, assigned_to, created_by, title, brief, status, parent_task_id)
      VALUES (${hiveId}, ${goal.id}, 'dev-agent', 'goal-supervisor', ${`${title} replacement ${i}`}, 'Recovery work', 'failed', ${root.id})
    `;
  }
  return { goalId: goal.id, rootTaskId: root.id };
}

function request(body: object) {
  return new Request("http://localhost:3000/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe.sequential("POST /api/tasks recovery-budget overrides", () => {
  beforeEach(async () => {
    await truncateAll(sql);
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('tasks-recovery-override', 'Tasks Recovery Override', 'digital')
      RETURNING id
    `;
    hiveId = hive.id;
  });

  it("creates a replacement task when a resolved family override increases the cap", async () => {
    const family = await createExhaustedFamily("Backend family");

    await sql`
      INSERT INTO decisions (hive_id, goal_id, task_id, title, context, status, route_metadata)
      VALUES (
        ${hiveId},
        ${family.goalId},
        ${family.rootTaskId},
        'Resolved backend override',
        'Approved continuation for this backend family',
        'resolved',
        ${sql.json({
          recoveryBudgetOverride: {
            enabled: true,
            taskFamilyRootId: family.rootTaskId,
            replacementTasksPerFailureFamily: 7,
          },
        })}
      )
    `;

    const res = await createTask(request({
      hiveId,
      assignedTo: "dev-agent",
      title: "RP-02 replacement",
      brief: "Create the next backend recovery task",
      goalId: family.goalId,
      sourceTaskId: family.rootTaskId,
      createdBy: "goal-supervisor",
    }));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.parentTaskId).toBe(family.rootTaskId);
  });

  it("still denies exhausted unrelated families without an approved override", async () => {
    const allowedFamily = await createExhaustedFamily("Allowed family");
    const blockedFamily = await createExhaustedFamily("Blocked family");

    await sql`
      INSERT INTO decisions (hive_id, goal_id, task_id, title, context, status, route_metadata)
      VALUES (
        ${hiveId},
        ${allowedFamily.goalId},
        ${allowedFamily.rootTaskId},
        'Resolved backend override',
        'Approved continuation for a different backend family',
        'resolved',
        ${sql.json({
          recoveryBudgetOverride: {
            enabled: true,
            taskFamilyRootId: allowedFamily.rootTaskId,
            replacementTasksPerFailureFamily: 7,
          },
        })}
      )
    `;

    const res = await createTask(request({
      hiveId,
      assignedTo: "dev-agent",
      title: "Blocked unrelated replacement",
      brief: "This should stay blocked",
      goalId: blockedFamily.goalId,
      sourceTaskId: blockedFamily.rootTaskId,
      createdBy: "goal-supervisor",
    }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("Recovery budget exhausted");
  });
});
