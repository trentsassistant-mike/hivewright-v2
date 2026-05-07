import { beforeEach, describe, expect, it } from "vitest";
import {
  checkRecoveryBudget,
  loadRecoveryBudget,
} from "@/recovery/recovery-budget";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;
let rootTaskId: string;

async function seedFamily() {
  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type)
    VALUES ('recovery-budget-visibility', 'Recovery Budget Visibility', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;

  const [root] = await sql<{ id: string }[]>`
    INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
    VALUES (${hiveId}, 'dev-agent', 'owner', 'Root task', 'do work', 'failed')
    RETURNING id
  `;
  rootTaskId = root.id;
}

describe.sequential("recovery-budget visibility for ea_review decisions", () => {
  beforeEach(async () => {
    await truncateAll(sql);
    await seedFamily();
  });

  it("loads the open ea_review decision IDs alongside the count", async () => {
    const [d1] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, task_id, title, context, status)
      VALUES (${hiveId}, ${rootTaskId}, 'EA review block', 'context', 'ea_review')
      RETURNING id
    `;

    const budget = await loadRecoveryBudget(sql, rootTaskId);
    expect(budget.openRecoveryDecisionCount).toBe(1);
    expect(budget.openRecoveryDecisions).toEqual([
      { id: d1.id, status: "ea_review" },
    ]);
  });

  it("includes ea_review IDs in the recovery-budget exhaustion error", async () => {
    const [d1] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, task_id, title, context, status)
      VALUES (${hiveId}, ${rootTaskId}, 'Hidden EA review block', 'context', 'ea_review')
      RETURNING id
    `;

    const decision = await checkRecoveryBudget(sql, rootTaskId, {
      action: "doctor escalation",
      reason: "doctor wants to create a recovery decision",
      recoveryDecisionsToCreate: 1,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toContain("Blocking decisions:");
      expect(decision.reason).toContain("ea_review");
      expect(decision.reason).toContain(d1.id);
    }
  });

  it("distinguishes pending vs ea_review blockers in the error", async () => {
    const [pendingDecision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, task_id, title, context, status)
      VALUES (${hiveId}, ${rootTaskId}, 'Pending owner', 'context', 'pending')
      RETURNING id
    `;
    const [eaReviewDecision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, task_id, title, context, status)
      VALUES (${hiveId}, ${rootTaskId}, 'EA review hidden', 'context', 'ea_review')
      RETURNING id
    `;

    const decision = await checkRecoveryBudget(sql, rootTaskId, {
      action: "doctor escalation",
      reason: "another decision wanted",
      recoveryDecisionsToCreate: 1,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toContain("in ea_review");
      expect(decision.reason).toContain(eaReviewDecision.id);
      expect(decision.reason).toContain("pending owner");
      expect(decision.reason).toContain(pendingDecision.id);
    }
  });

  it("omits the blocking-decisions sentence when the budget has room", async () => {
    const decision = await checkRecoveryBudget(sql, rootTaskId, {
      action: "doctor escalation",
      reason: "first attempt",
      recoveryDecisionsToCreate: 1,
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.budget.openRecoveryDecisions).toEqual([]);
      expect(decision.budget.openRecoveryDecisionCount).toBe(0);
    }
  });
});
