import { beforeEach, describe, expect, it } from "vitest";
import { checkRecoveryBudget } from "@/recovery/recovery-budget";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;

async function createFamily(title: string) {
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

describe.sequential("recovery budget override", () => {
  beforeEach(async () => {
    await truncateAll(sql);
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('recovery-budget-override', 'Recovery Budget Override', 'digital')
      RETURNING id
    `;
    hiveId = hive.id;
  });

  it("denies replacement work when the default cap is exhausted and no override exists", async () => {
    const family = await createFamily("No override");

    const decision = await checkRecoveryBudget(sql, family.rootTaskId, {
      action: "replacement create",
      reason: "Need another replacement",
      replacementTasksToCreate: 1,
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toContain("replacement tasks 4/3");
    }
  });

  it("ignores override metadata on unresolved decisions", async () => {
    const family = await createFamily("Pending override");

    await sql`
      INSERT INTO decisions (hive_id, goal_id, task_id, title, context, status, route_metadata)
      VALUES (
        ${hiveId},
        ${family.goalId},
        ${family.rootTaskId},
        'Pending recovery override',
        'Not resolved yet',
        'pending',
        ${sql.json({
          recoveryBudgetOverride: {
            enabled: true,
            taskFamilyRootId: family.rootTaskId,
            replacementTasksPerFailureFamily: 7,
          },
        })}
      )
    `;

    const decision = await checkRecoveryBudget(sql, family.rootTaskId, {
      action: "replacement create",
      reason: "Need another replacement",
      replacementTasksToCreate: 1,
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toContain("replacement tasks 4/3");
    }
  });

  it("allows additional replacement work for the family authorized by a resolved override decision", async () => {
    const family = await createFamily("Resolved override");

    await sql`
      INSERT INTO decisions (hive_id, goal_id, task_id, title, context, status, route_metadata)
      VALUES (
        ${hiveId},
        ${family.goalId},
        ${family.rootTaskId},
        'Resolved recovery override',
        'Approved continuation for this backend family only',
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

    const decision = await checkRecoveryBudget(sql, family.rootTaskId, {
      action: "replacement create",
      reason: "Need RP-02",
      replacementTasksToCreate: 1,
    });

    expect(decision.ok).toBe(true);
  });

  it("denies exhausted families when the resolved override is scoped to a different family", async () => {
    const allowedFamily = await createFamily("Allowed family");
    const blockedFamily = await createFamily("Blocked family");

    await sql`
      INSERT INTO decisions (hive_id, goal_id, task_id, title, context, status, route_metadata)
      VALUES (
        ${hiveId},
        ${allowedFamily.goalId},
        ${allowedFamily.rootTaskId},
        'Resolved recovery override',
        'Approved continuation for a different family',
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

    const decision = await checkRecoveryBudget(sql, blockedFamily.rootTaskId, {
      action: "replacement create",
      reason: "Need another replacement",
      replacementTasksToCreate: 1,
    });

    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toContain("replacement tasks 4/3");
    }
  });
});
