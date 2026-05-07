import { beforeEach, describe, expect, it } from "vitest";
import { getDecisionActivity } from "@/decisions/activity";
import { testSql as sql, truncateAll } from "../_lib/test-db";

describe.sequential("getDecisionActivity", () => {
  const HIVE_ID = "88888888-8888-8888-8888-888888888888";
  let goalId: string;
  let decisionId: string;

  beforeEach(async () => {
    await truncateAll(sql);
    await sql`
      INSERT INTO hives (id, slug, name, type)
      VALUES (${HIVE_ID}, 'decision-activity', 'Decision Activity', 'digital')
    `;
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${HIVE_ID}, 'Activity goal', 'active', 'supervisor-activity')
      RETURNING id
    `;
    goalId = goal.id;
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (
        hive_id, goal_id, title, context, priority, status,
        owner_response, ea_attempts, ea_reasoning, ea_decided_at
      )
      VALUES (
        ${HIVE_ID}, ${goalId}, 'Discuss design direction', 'Need direction',
        'normal', 'pending', 'discussed: make it more honeycomb', 1,
        'The owner gave enough direction for the design lane.',
        NOW() + INTERVAL '3 minutes'
      )
      RETURNING id
    `;
    decisionId = decision.id;
  });

  it("combines decision messages, mirror wakes, goal comments, EA judgement, and related EA decisions chronologically", async () => {
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO decision_messages (decision_id, sender, content, created_at, supervisor_woken_at)
      VALUES (
        ${decisionId},
        'owner',
        'Make the background faintly honeycomb and use more vibrant honey colours.',
        NOW(),
        NOW() + INTERVAL '1 minute'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO goal_comments (goal_id, body, created_by, created_at)
      VALUES
        (${goalId}, 'Owner commented on decision "Discuss design direction".', 'owner', NOW() + INTERVAL '2 minutes'),
        (${goalId}, 'Sprint 9 plan revision 21 acknowledges owner design direction.', 'goal-supervisor', NOW() + INTERVAL '4 minutes')
    `;
    const [related] = await sql<{ id: string }[]>`
      INSERT INTO decisions (
        hive_id, goal_id, title, context, priority, status,
        owner_response, ea_attempts, ea_reasoning, ea_decided_at, resolved_at, resolved_by
      )
      VALUES (
        ${HIVE_ID}, ${goalId}, 'Derivative design decision', 'Follow-up',
        'normal', 'resolved', 'ea-decided: use the owner honeycomb direction',
        1, 'The derivative matched the owner comment.',
        NOW() + INTERVAL '5 minutes', NOW() + INTERVAL '5 minutes', 'ea-resolver'
      )
      RETURNING id
    `;

    const activity = await getDecisionActivity(sql, decisionId);

    expect(activity.map((entry) => entry.actor)).toEqual(
      expect.arrayContaining(["owner", "system mirror", "supervisor", "ea-resolver"]),
    );
    expect(activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: "decision_message",
          sourceId: message.id,
          summary: expect.stringContaining("honeycomb"),
        }),
        expect.objectContaining({
          actor: "system mirror",
          summary: expect.stringContaining("woke the supervisor"),
        }),
        expect.objectContaining({
          sourceType: "goal_comment",
          summary: expect.stringContaining("Sprint 9 plan revision 21"),
        }),
        expect.objectContaining({
          sourceType: "decision",
          summary: expect.stringContaining("EA recorded outcome"),
        }),
        expect.objectContaining({
          sourceType: "descendant_decision",
          sourceId: related.id,
          summary: expect.stringContaining("Related decision"),
        }),
      ]),
    );
    const timestamps = activity.map((entry) => entry.timestamp.getTime());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });
});
