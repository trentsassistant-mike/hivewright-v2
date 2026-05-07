import { beforeEach, describe, expect, it, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { runIdeasDailyReview } from "@/ideas/daily-review";
import * as hiveContext from "@/hives/context";

async function seedHive(): Promise<string> {
  const slug = "ideas-" + Math.random().toString(36).slice(2, 8);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO hives (name, slug, type, mission)
    VALUES ('Ideas Hive', ${slug}, 'digital', 'Build the best ideas backlog.')
    RETURNING id
  `;
  await sql`
    INSERT INTO hive_targets (hive_id, title, target_value, status)
    VALUES (${row.id}, 'Ship backlog improvements', '1 this week', 'open')
  `;
  return row.id;
}

async function seedIdea(
  hiveId: string,
  title: string,
  opts: { status?: string; reviewedAtToday?: boolean } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO hive_ideas (hive_id, title, body, created_by, status, reviewed_at)
    VALUES (
      ${hiveId},
      ${title},
      ${title + " body"},
      'owner',
      ${opts.status ?? "open"},
      ${opts.reviewedAtToday ? new Date() : null}
    )
    RETURNING id
  `;
  return row.id;
}

describe("runIdeasDailyReview", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("short-circuits without building context or invoking the curator when there are no open ideas", async () => {
    const hiveId = await seedHive();
    const buildContext = vi.fn(async () => "should not be called");
    const invokeCurator = vi.fn(async () => ({
      picked_idea_id: null,
      fit_rationale: "n/a",
      recommended_action: "leave_open" as const,
    }));

    const result = await runIdeasDailyReview(sql, hiveId, {
      buildContext,
      invokeCurator,
    });

    expect(result).toEqual({
      skipped: true,
      reason: "no-open-ideas",
      openIdeas: 0,
    });
    expect(buildContext).not.toHaveBeenCalled();
    expect(invokeCurator).not.toHaveBeenCalled();
  });

  it("uses buildHiveContextBlock as the review context source and leaves the idea open when asked", async () => {
    const hiveId = await seedHive();
    const ideaId = await seedIdea(hiveId, "Rework onboarding flow");
    const contextSpy = vi.spyOn(hiveContext, "buildHiveContextBlock");
    const invokeCurator = vi.fn(async ({ contextBlock }: { contextBlock: string }) => {
      expect(contextBlock).toContain("## Hive Context");
      expect(contextBlock).toContain("**Mission:**");
      expect(contextBlock).toContain("**Targets:**");
      return {
        picked_idea_id: ideaId,
        fit_rationale: "Strong idea, but current target pressure says leave it open for tomorrow.",
        recommended_action: "leave_open" as const,
      };
    });

    const result = await runIdeasDailyReview(sql, hiveId, {
      invokeCurator,
    });

    expect(result.action).toBe("leave_open");
    expect(contextSpy).toHaveBeenCalledWith(sql, hiveId);

    const [idea] = await sql`
      SELECT status, ai_assessment, reviewed_at
      FROM hive_ideas
      WHERE id = ${ideaId}
    `;
    expect(idea.status).toBe("open");
    expect(idea.ai_assessment).toContain("leave it open");
    expect(idea.reviewed_at).not.toBeNull();
  });

  it("archives low-fit ideas and stores the curator assessment", async () => {
    const hiveId = await seedHive();
    const ideaId = await seedIdea(hiveId, "Open a physical retail location");

    const result = await runIdeasDailyReview(sql, hiveId, {
      buildContext: async () => "context",
      invokeCurator: async () => ({
        picked_idea_id: ideaId,
        fit_rationale: "Low fit with the current digital-only mission.",
        recommended_action: "archive_low_fit",
      }),
    });

    expect(result.action).toBe("archive_low_fit");

    const [idea] = await sql`
      SELECT status, ai_assessment, reviewed_at, promoted_to_goal_id
      FROM hive_ideas
      WHERE id = ${ideaId}
    `;
    expect(idea.status).toBe("archived");
    expect(idea.ai_assessment).toBe("Low fit with the current digital-only mission.");
    expect(idea.reviewed_at).not.toBeNull();
    expect(idea.promoted_to_goal_id).toBeNull();
  });

  it("promotes one of three open ideas through the /api/work shared path, writes the idea-origin preface into the first paragraph, and links only that idea to the new goal", async () => {
    const hiveId = await seedHive();
    const firstIdeaId = await seedIdea(hiveId, "Ideas digest");
    const secondIdeaId = await seedIdea(hiveId, "Beehive landing page refresh");
    const thirdIdeaId = await seedIdea(hiveId, "Weekly founder notes");

    const result = await runIdeasDailyReview(sql, hiveId, {
      buildContext: async () => "context",
      invokeCurator: async ({ openIdeas }) => {
        expect(openIdeas.map((idea) => idea.title)).toEqual([
          "Ideas digest",
          "Beehive landing page refresh",
          "Weekly founder notes",
        ]);

        return {
          picked_idea_id: secondIdeaId,
          fit_rationale: "Best fit for the current mission and targets.",
          recommended_action: "promote",
          goal_brief: "Create a daily ideas digest goal.",
        };
      },
    });

    expect(result.action).toBe("promote");
    expect(result.openIdeas).toBe(3);
    expect(result.pickedIdeaId).toBe(secondIdeaId);
    expect(result.promotedGoalId).toBeTruthy();
    const promotedGoalId = result.promotedGoalId as string;

    const [promotedIdea] = await sql`
      SELECT status, ai_assessment, reviewed_at, promoted_to_goal_id
      FROM hive_ideas
      WHERE id = ${secondIdeaId}
    `;
    const untouchedIdeas = await sql`
      SELECT id, status, ai_assessment, reviewed_at, promoted_to_goal_id
      FROM hive_ideas
      WHERE id IN (${firstIdeaId}, ${thirdIdeaId})
      ORDER BY created_at ASC
    `;
    const [goal] = await sql`
      SELECT description
      FROM goals
      WHERE id = ${promotedGoalId}
    `;
    const [{ promotedCount }] = await sql<Array<{ promotedCount: string }>>`
      SELECT COUNT(*)::text AS "promotedCount"
      FROM hive_ideas
      WHERE hive_id = ${hiveId}
        AND status = 'promoted'
    `;

    expect(promotedIdea.status).toBe("promoted");
    expect(promotedIdea.ai_assessment).toBe("Best fit for the current mission and targets.");
    expect(promotedIdea.reviewed_at).not.toBeNull();
    expect(promotedIdea.promoted_to_goal_id).toBe(promotedGoalId);
    expect(untouchedIdeas).toHaveLength(2);
    expect(untouchedIdeas.every((idea) => idea.status === "open")).toBe(true);
    expect(untouchedIdeas.every((idea) => idea.ai_assessment === null)).toBe(true);
    expect(untouchedIdeas.every((idea) => idea.reviewed_at === null)).toBe(true);
    expect(untouchedIdeas.every((idea) => idea.promoted_to_goal_id === null)).toBe(true);
    expect(promotedCount).toBe("1");
    expect(String(goal.description).split(/\n\s*\n/, 1)[0]).toBe(
      `From your idea ${secondIdeaId}: Beehive landing page refresh`,
    );
    expect(String(goal.description)).toContain("Create a daily ideas digest goal.");
  });

  it("enforces the one-promotion-per-day cap by leaving later ideas open and skipping work submission", async () => {
    const hiveId = await seedHive();
    await seedIdea(hiveId, "Already promoted today", {
      status: "promoted",
      reviewedAtToday: true,
    });
    const ideaId = await seedIdea(hiveId, "Another strong idea");
    const submitWork = vi.fn(async () => {
      throw new Error("should not be called when the cap is already used");
    });

    const result = await runIdeasDailyReview(sql, hiveId, {
      buildContext: async () => "context",
      invokeCurator: async () => ({
        picked_idea_id: ideaId,
        fit_rationale: "Strong fit, but we already promoted one idea today.",
        recommended_action: "promote",
        goal_brief: "Promote the second idea anyway.",
      }),
      submitWork,
    });

    expect(result.action).toBe("leave_open");
    expect(submitWork).not.toHaveBeenCalled();

    const [idea] = await sql`
      SELECT status, ai_assessment, reviewed_at
      FROM hive_ideas
      WHERE id = ${ideaId}
    `;
    const [{ count }] = await sql<Array<{ count: string }>>`
      SELECT COUNT(*)::text AS count
      FROM hive_ideas
      WHERE hive_id = ${hiveId}
        AND status = 'promoted'
        AND reviewed_at::date = CURRENT_DATE
    `;
    expect(idea.status).toBe("open");
    expect(idea.ai_assessment).toContain("one-idea-per-day cap");
    expect(idea.reviewed_at).not.toBeNull();
    expect(Number(count)).toBe(1);
  });
});
