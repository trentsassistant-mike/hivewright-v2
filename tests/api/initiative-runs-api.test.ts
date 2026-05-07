import { describe, it, expect, beforeEach } from "vitest";
import { createGetInitiativeRunsHandler } from "@/app/api/initiative-runs/route";
import { createGetInitiativeRunDetailHandler } from "@/app/api/initiative-runs/[runId]/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE = "aaaaaaaa-0000-0000-0000-000000000111";
const OTHER_HIVE = "bbbbbbbb-0000-0000-0000-000000000222";

async function seedHive(id: string, slug: string): Promise<void> {
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${id}, ${slug}, ${slug}, 'digital')
  `;
}

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Developer Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  await seedHive(HIVE, "initiative-hive");
  await seedHive(OTHER_HIVE, "other-initiative-hive");
});

describe("GET /api/initiative-runs", () => {
  it("returns summary metrics plus recent runs for the requested hive", async () => {
    const GET = createGetInitiativeRunsHandler(sql);

    await sql`
      INSERT INTO initiative_runs (
        hive_id, trigger_type, status, started_at, completed_at,
        evaluated_candidates, created_count, created_goals, created_tasks,
        created_decisions, suppressed_count, noop_count, suppression_reasons,
        run_failures, failure_reason
      ) VALUES (
        ${HIVE}::uuid,
        'ideas-backlog',
        'completed',
        NOW() - interval '30 minutes',
        NOW() - interval '28 minutes',
        7,
        2,
        1,
        1,
        0,
        5,
        0,
        ${sql.json({ duplicate_goal: 3, low_signal: 2 })},
        0,
        NULL
      ), (
        ${HIVE}::uuid,
        'dormant-goals',
        'failed',
        NOW() - interval '2 hours',
        NOW() - interval '118 minutes',
        4,
        0,
        0,
        0,
        0,
        4,
        0,
        ${sql.json({ already_owned: 1, under_review: 3 })},
        1,
        'upstream timeout'
      ), (
        ${OTHER_HIVE}::uuid,
        'ideas-backlog',
        'completed',
        NOW() - interval '10 minutes',
        NOW() - interval '9 minutes',
        99,
        99,
        99,
        0,
        0,
        0,
        0,
        ${sql.json({})},
        0,
        NULL
      )
    `;

    const res = await GET(
      new Request(`http://localhost/api/initiative-runs?hiveId=${HIVE}&limit=5&windowHours=24`),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.summary).toMatchObject({
      windowHours: 24,
      runCount: 2,
      completedRuns: 1,
      failedRuns: 1,
      evaluatedCandidates: 11,
      createdItems: 2,
      suppressedItems: 9,
      runFailures: 1,
    });
    expect(body.data.summary.suppressionReasons).toEqual([
      { reason: "duplicate_goal", count: 3 },
      { reason: "under_review", count: 3 },
      { reason: "already_owned", count: 1 },
      { reason: "low_signal", count: 2 },
    ].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)));

    expect(body.data.runs).toHaveLength(2);
    expect(body.data.runs[0]).toMatchObject({
      hiveId: HIVE,
      trigger: "ideas-backlog",
      status: "completed",
      evaluatedCandidates: 7,
      createdCount: 2,
      suppressedCount: 5,
      runFailures: 0,
    });
    expect(body.data.runs[0].created).toEqual({ goals: 1, tasks: 1, decisions: 0 });
    expect(body.data.runs[1]).toMatchObject({
      trigger: "dormant-goals",
      status: "failed",
      failureReason: "upstream timeout",
      runFailures: 1,
    });
  });

  it("returns decision-level linkage for a selected run", async () => {
    const GET = createGetInitiativeRunDetailHandler(sql);

    await sql`
      INSERT INTO goals (id, hive_id, title, status)
      VALUES (
        '33333333-3333-4333-8333-333333333333',
        ${HIVE}::uuid,
        'Dormant goal A',
        'active'
      ), (
        '44444444-4444-4444-8444-444444444444',
        ${HIVE}::uuid,
        'Dormant goal B',
        'active'
      ), (
        '55555555-5555-4555-8555-555555555555',
        ${HIVE}::uuid,
        'Expand partner channel',
        'active'
      ), (
        '66666666-6666-4666-8666-666666666666',
        ${HIVE}::uuid,
        'Create partner playbook goal',
        'pending'
      )
    `;

    const [run] = await sql<Array<{ id: string }>>`
      INSERT INTO initiative_runs (
        hive_id, trigger_type, trigger_ref, status, started_at, completed_at,
        evaluated_candidates, created_count, created_goals, created_tasks,
        created_decisions, suppressed_count, noop_count, suppression_reasons,
        run_failures, failure_reason
      ) VALUES (
        ${HIVE}::uuid,
        'schedule',
        '11111111-1111-1111-1111-111111111111',
        'completed',
        NOW() - interval '15 minutes',
        NOW() - interval '14 minutes',
        2,
        1,
        0,
        1,
        0,
        1,
        0,
        ${sql.json({ per_run_cap: 1 })},
        0,
        NULL
      )
      RETURNING id
    `;

    await sql`
      INSERT INTO tasks (
        id, hive_id, assigned_to, created_by, title, brief, status, priority, qa_required
      ) VALUES (
        '22222222-2222-2222-2222-222222222222',
        ${HIVE}::uuid,
        'dev-agent',
        'initiative-engine',
        'Restart dormant goal A',
        'Follow up on dormant goal A.',
        'pending',
        4,
        false
      )
    `;

    await sql`
      INSERT INTO initiative_run_decisions (
        run_id, hive_id, trigger_type, candidate_key, candidate_ref,
        action_taken, rationale, suppression_reason, dedupe_key,
        cooldown_hours, per_run_cap, per_day_cap, evidence, created_task_id, created_goal_id, created_at
      ) VALUES (
        ${run.id},
        ${HIVE}::uuid,
        'schedule',
        'dormant-goal-next-task:33333333-3333-4333-8333-333333333333',
        '33333333-3333-4333-8333-333333333333',
        'create_task',
        'Created a restart task for dormant goal "A".',
        NULL,
        'dormant-goal-next-task:33333333-3333-4333-8333-333333333333',
        24,
        1,
        2,
        ${sql.json({
          trigger: { kind: "schedule", scheduleId: "11111111-1111-1111-1111-111111111111" },
          candidate: {
            kind: "dormant-goal-next-task",
            goalId: "33333333-3333-4333-8333-333333333333",
            goalTitle: "Dormant goal A",
          },
          creation: {
            workItemId: "task-a",
            workItemType: "task",
            assignedTo: "dev-agent",
            classification: {
              provider: "test-provider",
              model: "test-model",
              confidence: 0.91,
              reasoning: "task classification",
              usedFallback: false,
              role: "dev-agent",
              ignoredField: "should-not-leak",
            },
          },
        })},
        '22222222-2222-2222-2222-222222222222',
        NULL,
        NOW() - interval '14 minutes'
      ), (
        ${run.id},
        ${HIVE}::uuid,
        'schedule',
        'dormant-goal-next-task:44444444-4444-4444-8444-444444444444',
        '44444444-4444-4444-8444-444444444444',
        'suppress',
        'Suppressed initiative follow-up for dormant goal "B" because this run already created its maximum work item.',
        'per_run_cap',
        'dormant-goal-next-task:44444444-4444-4444-8444-444444444444',
        24,
        1,
        2,
        ${sql.json({
          trigger: { kind: "schedule", scheduleId: "11111111-1111-1111-1111-111111111111" },
          candidate: {
            kind: "dormant-goal-next-task",
            goalId: "44444444-4444-4444-8444-444444444444",
            goalTitle: "Dormant goal B",
          },
          suppression: {
            reason: "per_run_cap",
            reasons: ["per_run_cap", "queue_saturated"],
            assignedTo: "ops-agent",
          },
        })},
        NULL,
        NULL,
        NOW() - interval '13 minutes'
      ), (
        ${run.id},
        ${HIVE}::uuid,
        'schedule',
        'promote-goal:55555555-5555-4555-8555-555555555555',
        '55555555-5555-4555-8555-555555555555',
        'create_goal',
        'Promoted the candidate into a standalone goal.',
        NULL,
        'promote-goal:55555555-5555-4555-8555-555555555555',
        24,
        1,
        2,
        ${sql.json({
          trigger: { kind: "schedule", scheduleId: "11111111-1111-1111-1111-111111111111" },
          candidate: {
            kind: "promote-goal",
            goalId: "55555555-5555-4555-8555-555555555555",
            goalTitle: "Expand partner channel",
          },
          creation: {
            workItemId: "66666666-6666-4666-8666-666666666666",
            assigned_role: "design-agent",
            classification: {
              provider: "legacy-provider",
              confidence: 0.64,
              reasoning: "Older payload omitted workItemType but still recorded the role.",
            },
          },
        })},
        NULL,
        '66666666-6666-4666-8666-666666666666',
        NOW() - interval '12 minutes'
      )
    `;

    const res = await GET(new Request(`http://localhost/api/initiative-runs/${run.id}?hiveId=${HIVE}`), {
      params: Promise.resolve({ runId: run.id }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.run).toMatchObject({
      runId: run.id,
      id: run.id,
      hiveId: HIVE,
      trigger: "schedule",
      triggerRef: "11111111-1111-1111-1111-111111111111",
      createdCount: 1,
      suppressedCount: 1,
    });
    expect(body.data.run.decisions).toEqual([
      expect.objectContaining({
        runId: run.id,
        candidate_key: "dormant-goal-next-task:33333333-3333-4333-8333-333333333333",
        candidate_ref: "33333333-3333-4333-8333-333333333333",
        candidate_kind: "dormant-goal-next-task",
        target_goal_id: "33333333-3333-4333-8333-333333333333",
        target_goal_title: "Dormant goal A",
        action_taken: "create_task",
        created_task_id: "22222222-2222-2222-2222-222222222222",
        created_task_title: "Restart dormant goal A",
        created_goal_id: null,
        created_goal_title: null,
        suppression_reason: null,
        suppression_reasons: [],
        classified_outcome: {
          workItemType: "task",
          classifiedRole: "dev-agent",
          classification: {
            provider: "test-provider",
            model: "test-model",
            confidence: 0.91,
            reasoning: "task classification",
            usedFallback: false,
            role: "dev-agent",
          },
        },
      }),
      expect.objectContaining({
        runId: run.id,
        candidate_key: "dormant-goal-next-task:44444444-4444-4444-8444-444444444444",
        candidate_ref: "44444444-4444-4444-8444-444444444444",
        candidate_kind: "dormant-goal-next-task",
        target_goal_id: "44444444-4444-4444-8444-444444444444",
        target_goal_title: "Dormant goal B",
        action_taken: "suppress",
        created_goal_id: null,
        created_goal_title: null,
        created_task_id: null,
        created_task_title: null,
        suppression_reason: "per_run_cap",
        suppression_reasons: ["per_run_cap", "queue_saturated"],
        classified_outcome: null,
      }),
      expect.objectContaining({
        runId: run.id,
        candidate_key: "promote-goal:55555555-5555-4555-8555-555555555555",
        candidate_ref: "55555555-5555-4555-8555-555555555555",
        candidate_kind: "promote-goal",
        target_goal_id: "55555555-5555-4555-8555-555555555555",
        target_goal_title: "Expand partner channel",
        action_taken: "create_goal",
        created_goal_id: "66666666-6666-4666-8666-666666666666",
        created_goal_title: "Create partner playbook goal",
        created_task_id: null,
        created_task_title: null,
        suppression_reason: null,
        suppression_reasons: [],
        classified_outcome: {
          workItemType: "goal",
          classifiedRole: "design-agent",
          classification: {
            provider: "legacy-provider",
            confidence: 0.64,
            reasoning: "Older payload omitted workItemType but still recorded the role.",
          },
        },
      }),
    ]);
    expect(body.data.run.decisions[0].classified_outcome.classification.ignoredField).toBeUndefined();
    expect(body.data.run.decisions[0].evidence).toBeUndefined();
    expect(body.data.run.decisions[0].dedupe_key).toBeUndefined();
    expect(body.data.run.decisions[0].classified_outcome.assignedTo).toBeUndefined();
    expect(body.data.run.decisions[1].assignedTo).toBeUndefined();
  });

  it("rejects missing or invalid hive ids", async () => {
    const GET = createGetInitiativeRunsHandler(sql);
    const GET_DETAIL = createGetInitiativeRunDetailHandler(sql);

    expect((await GET(new Request("http://localhost/api/initiative-runs"))).status).toBe(400);
    expect(
      (await GET(
        new Request("http://localhost/api/initiative-runs?hiveId=not-a-uuid"),
      )).status,
    ).toBe(400);
    expect(
      (await GET_DETAIL(new Request(`http://localhost/api/initiative-runs/not-a-uuid?hiveId=${HIVE}`), {
        params: Promise.resolve({ runId: "not-a-uuid" }),
      })).status,
    ).toBe(400);
    expect(
      (await GET_DETAIL(
        new Request("http://localhost/api/initiative-runs/11111111-1111-1111-1111-111111111111"),
        { params: Promise.resolve({ runId: "11111111-1111-1111-1111-111111111111" }) },
      )).status,
    ).toBe(400);
  });
});
