import { describe, it, expect, beforeEach } from "vitest";
import {
  upsertGoalPlan,
  getGoalPlan,
  listGoalDocuments,
} from "@/goals/goal-documents";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;
let goalId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('gdoc-test-biz', 'GDoc Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id as string;

  // session_id is set so the running dispatcher's findNewGoals query
  // (WHERE session_id IS NULL) skips this fixture. Without this, a live
  // dispatcher races the test and creates real tasks against our goal.
  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, status, session_id)
    VALUES (${bizId}, 'gdoc-test-goal', 'active', 'gs-gdoc-test-fixture')
    RETURNING *
  `;
  goalId = goal.id as string;
});


describe("upsertGoalPlan", () => {
  it("inserts a new plan with revision 1 when none exists", async () => {
    const plan = await upsertGoalPlan(sql, goalId, {
      title: "gdoc-test-plan",
      body: "# Goal Summary\nShip it.",
      createdBy: "goal-supervisor",
    });
    expect(plan.revision).toBe(1);
    expect(plan.documentType).toBe("plan");
    expect(plan.body).toContain("Ship it.");
  });

  it("updates the existing plan and bumps revision", async () => {
    await upsertGoalPlan(sql, goalId, {
      title: "gdoc-test-plan",
      body: "v1",
      createdBy: "goal-supervisor",
    });
    const updated = await upsertGoalPlan(sql, goalId, {
      title: "gdoc-test-plan",
      body: "v2",
      createdBy: "goal-supervisor",
    });
    expect(updated.revision).toBe(2);
    expect(updated.body).toBe("v2");

    const rows = await sql`
      SELECT COUNT(*)::int AS count FROM goal_documents
      WHERE goal_id = ${goalId} AND document_type = 'plan'
    `;
    expect(rows[0].count).toBe(1);
  });
});

describe("getGoalPlan", () => {
  it("returns null when no plan exists", async () => {
    const plan = await getGoalPlan(sql, goalId);
    expect(plan).toBeNull();
  });

  it("returns the plan when one exists", async () => {
    await upsertGoalPlan(sql, goalId, {
      title: "gdoc-test-plan",
      body: "# hello",
      createdBy: "goal-supervisor",
    });
    const plan = await getGoalPlan(sql, goalId);
    expect(plan).not.toBeNull();
    expect(plan!.title).toBe("gdoc-test-plan");
    expect(plan!.body).toBe("# hello");
  });
});

describe("listGoalDocuments", () => {
  it("returns all documents for a goal", async () => {
    await upsertGoalPlan(sql, goalId, {
      title: "gdoc-test-plan",
      body: "# p",
      createdBy: "goal-supervisor",
    });
    const docs = await listGoalDocuments(sql, goalId);
    expect(docs.length).toBe(1);
    expect(docs[0].documentType).toBe("plan");
  });
});
