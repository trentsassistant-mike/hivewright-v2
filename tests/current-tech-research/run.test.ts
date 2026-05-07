import { beforeEach, describe, expect, it } from "vitest";
import {
  CURRENT_TECH_RESEARCH_COMMENT_AUTHOR,
  CURRENT_TECH_RESEARCH_PLAN_VERSION,
  buildCurrentTechResearchPlan,
  buildHiveWrightUpdatedNotificationMessage,
  runCurrentTechResearchDaily,
} from "@/current-tech-research";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [hive] = await sql<Array<{ id: string }>>`
    INSERT INTO hives (slug, name, type)
    VALUES ('current-tech-run-test', 'Current Tech Run Test', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;
});

describe("runCurrentTechResearchDaily", () => {
  it("creates one recurring goal, plan, and dated kickoff comment", async () => {
    const result = await runCurrentTechResearchDaily(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId: "11111111-1111-1111-1111-111111111111" },
      now: new Date("2026-04-27T22:45:00.000Z"),
    });

    expect(result.goalCreated).toBe(true);
    expect(result.planUpdated).toBe(true);
    expect(result.kickoffCreated).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.cycleDate).toBe("2026-04-28");

    const goals = await sql<Array<{ id: string; title: string; status: string }>>`
      SELECT id, title, status FROM goals WHERE hive_id = ${hiveId}::uuid
    `;
    expect(goals).toHaveLength(1);
    expect(goals[0].title).toBe("Current tech research");
    expect(goals[0].status).toBe("active");

    const [plan] = await sql<Array<{ title: string; body: string }>>`
      SELECT title, body FROM goal_documents WHERE goal_id = ${result.goalId}::uuid
    `;
    expect(plan.title).toBe("Current Tech Research Recurring Workflow");
    expect(plan.body).toContain(CURRENT_TECH_RESEARCH_PLAN_VERSION);
    expect(plan.body).toContain("qaRequired: true");
    expect(plan.body).toContain("Final Step - Commit");
    expect(plan.body).toContain("HiveWright Updated");

    const [comment] = await sql<Array<{ body: string; created_by: string }>>`
      SELECT body, created_by FROM goal_comments WHERE goal_id = ${result.goalId}::uuid
    `;
    expect(comment.created_by).toBe(CURRENT_TECH_RESEARCH_COMMENT_AUTHOR);
    expect(comment.body).toContain("current-tech-research-cycle:2026-04-28");
    expect(comment.body).toContain("research -> synthesis/analysis -> HiveWright usefulness assessment");
  });

  it("does not create duplicate goals, plans, comments, or tasks for the same daily cycle", async () => {
    const options = {
      hiveId,
      trigger: { kind: "schedule" as const, scheduleId: "22222222-2222-2222-2222-222222222222" },
      now: new Date("2026-04-28T01:00:00.000Z"),
    };

    const first = await runCurrentTechResearchDaily(sql, options);
    const second = await runCurrentTechResearchDaily(sql, options);

    expect(first.kickoffCreated).toBe(true);
    expect(second.goalId).toBe(first.goalId);
    expect(second.kickoffCreated).toBe(false);
    expect(second.duplicate).toBe(true);

    const [{ goals }] = await sql<Array<{ goals: number }>>`
      SELECT COUNT(*)::int AS goals FROM goals WHERE hive_id = ${hiveId}::uuid
    `;
    expect(goals).toBe(1);

    const [{ comments }] = await sql<Array<{ comments: number }>>`
      SELECT COUNT(*)::int AS comments FROM goal_comments WHERE goal_id = ${first.goalId}::uuid
    `;
    expect(comments).toBe(1);

    const [{ plans }] = await sql<Array<{ plans: number }>>`
      SELECT COUNT(*)::int AS plans FROM goal_documents WHERE goal_id = ${first.goalId}::uuid
    `;
    expect(plans).toBe(1);

    const [{ tasks }] = await sql<Array<{ tasks: number }>>`
      SELECT COUNT(*)::int AS tasks FROM tasks WHERE hive_id = ${hiveId}::uuid
    `;
    expect(tasks).toBe(0);
  });
});

describe("current tech research plan and notification contracts", () => {
  it("keeps every rubric dimension and guardrail visible in the plan", () => {
    const plan = buildCurrentTechResearchPlan();
    for (const text of [
      "Mission fit",
      "User/product impact",
      "Implementation effort",
      "Security/privacy risk",
      "Maturity/reliability",
      "Cost",
      "Licensing/legal fit",
      "Operational complexity",
      "Reversibility",
      "Time-to-value",
      "Unsafe changes",
      "Duplicative changes",
      "Speculative changes",
      "Expensive changes",
    ]) {
      expect(plan).toContain(text);
    }
  });

  it("requires the canonical Research-stage output contract and boundary", () => {
    const plan = buildCurrentTechResearchPlan();
    for (const text of [
      "daily-current-tech-research-contract",
      "buildEvaluatedReleaseFindingKey",
      "cycle_date",
      "cycle_timezone",
      "scan_window",
      "source_urls",
      "vendor/product/version-or-unversioned/release-date/source",
      "publication_or_release_dates",
      "source_type",
      "confidence",
      "evidence_quality",
      "verified_facts",
      "interpretation",
      "hivewright_relevance_hypothesis",
      "duplicate_check",
      "duplicate_check_result",
      "action_class_candidate",
      "volume_summary",
      "exclusions",
      "no_action_notes",
      "traceability_matrix_handoff",
      "rubric_handoff",
      "handoff_notes",
      "Stop at Research",
      "must not perform synthesis, usefulness scoring, implementation routing, QA, owner decisions, or notification",
      "Downstream synthesis must consume that work product",
      "Final Step - Commit",
    ]) {
      expect(plan).toContain(text);
    }
  });

  it("builds the required owner notification shape for shipped improvements", () => {
    const notification = buildHiveWrightUpdatedNotificationMessage({
      shippedChange: "Added a provider release check.",
      newCapability: "detect model changes before they break agent routing",
      caveats: "Only official release notes are used for implementation decisions.",
    });

    expect(notification.title).toBe("HiveWright Updated");
    expect(notification.message).toContain("Added a provider release check.");
    expect(notification.message).toContain("HiveWright can now detect model changes");
    expect(notification.priority).toBe("normal");
    expect(notification.source).toBe("current-tech-research");
  });
});
