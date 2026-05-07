import { beforeEach, describe, expect, it } from "vitest";
import { GET as listDecisions } from "@/app/api/decisions/route";
import { POST as respondToDecision } from "@/app/api/decisions/[id]/respond/route";
import {
  createQualityFeedbackQaFixture,
  withQualityFeedbackQaFixture,
} from "@/quality/qa-fixtures";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE = "cccccccc-2222-4222-8222-cccccccccccc";
const TASK = "20000000-0000-4000-8000-000000000001";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE}, 'quality-response', 'Quality Response', 'digital')
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Dev Agent', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  await sql`
    INSERT INTO tasks (
      id, hive_id, assigned_to, created_by, status, priority,
      title, brief, completed_at
    )
    VALUES (
      ${TASK}, ${HIVE}, 'dev-agent', 'test', 'completed', 5,
      'Completed task', 'Task brief', '2026-04-26T12:00:00.000Z'
    )
  `;
});

async function createQualityDecision(lane: "owner" | "ai_peer" = "owner"): Promise<string> {
  const [decision] = await sql<{ id: string }[]>`
    INSERT INTO decisions (
      hive_id, task_id, title, context, recommendation,
      options, priority, status, kind
    )
    VALUES (
      ${HIVE},
      ${TASK},
      'Task quality check: Completed task',
      'ctx',
      'Rate this completed task from 1-10.',
      ${sql.json({
        kind: "task_quality_feedback",
        lane,
        provenance: lane === "ai_peer" ? "ai_peer_feedback_sampler" : "owner_feedback_sampler",
        responseModel: "quality_rating_v1",
        task: { id: TASK, role: "dev-agent" },
        fields: [
          { name: "rating", type: "integer", min: 1, max: 10, required: true },
          { name: "comment", type: "text", required: false },
        ],
      })},
      'normal',
      'pending',
      'task_quality_feedback'
    )
    RETURNING id
  `;
  return decision.id;
}

function respondReq(decisionId: string, body: object) {
  return respondToDecision(
    new Request(`http://localhost/api/decisions/${decisionId}/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: decisionId }) },
  );
}

describe("POST /api/decisions/[id]/respond — task quality feedback", () => {
  it("creates exactly one decision message for a Discuss response", async () => {
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (
        hive_id, title, context, recommendation, options,
        priority, status, kind
      )
      VALUES (
        ${HIVE},
        'Discuss design direction',
        'The design lane needs owner direction.',
        null,
        ${sql.json([])},
        'normal',
        'pending',
        'decision'
      )
      RETURNING id
    `;

    const res = await respondReq(decision.id, {
      response: "discussed",
      comment: "Use a faint honeycomb background and more vibrant honey colours.",
    });

    expect(res.status).toBe(200);

    const messages = await sql<{ content: string }[]>`
      SELECT content
      FROM decision_messages
      WHERE decision_id = ${decision.id}
      ORDER BY created_at ASC
    `;
    expect(messages).toEqual([
      {
        content: "Use a faint honeycomb background and more vibrant honey colours.",
      },
    ]);

    const [row] = await sql<{ status: string; owner_response: string | null }[]>`
      SELECT status, owner_response
      FROM decisions
      WHERE id = ${decision.id}
    `;
    expect(row).toMatchObject({
      status: "pending",
      owner_response: "discussed: Use a faint honeycomb background and more vibrant honey colours.",
    });
  });

  it("writes explicit owner-feedback signal rows for valid rating and optional comment", async () => {
    const decisionId = await createQualityDecision();

    const res = await respondReq(decisionId, {
      response: "quality_feedback",
      rating: 9,
      comment: "Strong work, matched the brief.",
    });

    expect(res.status).toBe(200);
    const [signal] = await sql<{
      task_id: string;
      hive_id: string;
      signal_type: string;
      source: string;
      evidence: string;
      confidence: number;
      rating: number;
      comment: string | null;
    }[]>`
      SELECT task_id, hive_id, signal_type, source, evidence,
             confidence, rating, comment
      FROM task_quality_signals
      WHERE task_id = ${TASK}
    `;

    expect(signal).toMatchObject({
      task_id: TASK,
      hive_id: HIVE,
      signal_type: "positive",
      source: "explicit_owner_feedback",
      rating: 9,
      comment: "Strong work, matched the brief.",
    });
    expect(signal.confidence).toBe(1);
    expect(signal.evidence).toContain(`Decision ${decisionId}: owner rated task quality 9/10.`);
    expect(signal.evidence).toContain("Owner comment: Strong work");

    const [decision] = await sql<{ status: string; owner_response: string }[]>`
      SELECT status, owner_response FROM decisions WHERE id = ${decisionId}
    `;
    expect(decision.status).toBe("resolved");
    expect(decision.owner_response).toContain("quality_feedback");
  });

  it("writes AI peer review ratings through the same endpoint with distinct provenance", async () => {
    const decisionId = await createQualityDecision("ai_peer");

    const res = await respondReq(decisionId, {
      response: "quality_feedback",
      rating: 8,
      comment: "Implementation is solid; verification evidence is adequate.",
    });

    expect(res.status).toBe(200);
    const [signal] = await sql<{ source: string; evidence: string; rating: number; comment: string }[]>`
      SELECT source, evidence, rating, comment
      FROM task_quality_signals
      WHERE task_id = ${TASK}
    `;

    expect(signal.source).toBe("explicit_ai_peer_feedback");
    expect(signal.rating).toBe(8);
    expect(signal.evidence).toContain(`Decision ${decisionId}: AI peer reviewer rated task quality 8/10.`);
    expect(signal.evidence).toContain("AI peer review: Implementation is solid");
  });

  it("stores neutral and negative ratings using the Sprint 1 signal_type schema", async () => {
    const neutralDecision = await createQualityDecision();
    await respondReq(neutralDecision, { response: "quality_feedback", rating: 6 });

    const negativeDecision = await createQualityDecision();
    await respondReq(negativeDecision, { response: "quality_feedback", rating: 3 });

    const rows = await sql<{ signal_type: string; rating: number }[]>`
      SELECT signal_type, rating
      FROM task_quality_signals
      WHERE source = 'explicit_owner_feedback'
      ORDER BY created_at ASC
    `;
    expect(rows).toEqual([
      { signal_type: "neutral", rating: 6 },
      { signal_type: "negative", rating: 3 },
    ]);

    const [candidate] = await sql<{ role_slug: string; slug: string; evidence: unknown[] }[]>`
      SELECT role_slug, slug, evidence
      FROM skill_drafts
      WHERE hive_id = ${HIVE}
        AND role_slug = 'dev-agent'
    `;
    expect(candidate.role_slug).toBe("dev-agent");
    expect(candidate.slug).toBe("dev-agent-feedback-skill-improvement");
    expect(candidate.evidence).toHaveLength(2);
  });

  it("dismissals and no-rating responses do not create penalty signals", async () => {
    const dismissDecision = await createQualityDecision();
    const dismissRes = await respondReq(dismissDecision, {
      response: "dismiss_quality_feedback",
      comment: "No opinion",
    });
    expect(dismissRes.status).toBe(200);

    const rejectedDecision = await createQualityDecision();
    const rejectedRes = await respondReq(rejectedDecision, { response: "rejected" });
    expect(rejectedRes.status).toBe(200);

    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM task_quality_signals
    `;
    expect(count).toBe(0);
  });

  it("rejects quality feedback responses without a valid 1-10 rating", async () => {
    const decisionId = await createQualityDecision();

    const res = await respondReq(decisionId, {
      response: "quality_feedback",
      rating: 11,
    });

    expect(res.status).toBe(400);
    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM task_quality_signals
    `;
    expect(count).toBe(0);
  });

  it("hides QA fixture decisions from owner-facing decisions lists by default", async () => {
    const realDecisionId = await createQualityDecision();
    const fixture = await createQualityFeedbackQaFixture(sql, {
      hiveId: HIVE,
      runId: "qa-smoke-list-hidden",
    });

    const defaultRes = await listDecisions(new Request(
      `http://localhost/api/decisions?hiveId=${HIVE}&status=pending&includeKinds=task_quality_feedback`,
    ));
    const defaultBody = await defaultRes.json();

    expect(defaultRes.status).toBe(200);
    expect(defaultBody.total).toBe(1);
    expect(defaultBody.data.map((row: { id: string }) => row.id)).toEqual([realDecisionId]);

    const previousSmoke = process.env.HIVEWRIGHT_QA_SMOKE;
    process.env.HIVEWRIGHT_QA_SMOKE = "true";
    try {
      const fixtureRes = await listDecisions(new Request(
        `http://localhost/api/decisions?hiveId=${HIVE}&status=pending&includeKinds=task_quality_feedback&qaFixtures=true&qaRunId=${fixture.runId}`,
      ));
      const fixtureBody = await fixtureRes.json();
      expect(fixtureRes.status).toBe(200);
      expect(fixtureBody.total).toBe(1);
      expect(fixtureBody.data[0]).toMatchObject({
        id: fixture.decisionId,
        isQaFixture: true,
      });
    } finally {
      if (previousSmoke === undefined) delete process.env.HIVEWRIGHT_QA_SMOKE;
      else process.env.HIVEWRIGHT_QA_SMOKE = previousSmoke;
      await sql`DELETE FROM decisions WHERE id = ${fixture.decisionId}`;
      await sql`DELETE FROM tasks WHERE id = ${fixture.taskId}`;
    }
  });

  it("marks fixture quality signals and cleans fixtures after failed QA smoke runs", async () => {
    const realDecisionId = await createQualityDecision();
    await respondReq(realDecisionId, {
      response: "quality_feedback",
      rating: 8,
      comment: "Real owner signal stays.",
    });

    await expect(withQualityFeedbackQaFixture(sql, async (fixture) => {
      await respondReq(fixture.decisionId, {
        response: "quality_feedback",
        rating: 9,
        comment: "QA smoke should be cleaned.",
      });
      const [fixtureSignal] = await sql<{ is_qa_fixture: boolean }[]>`
        SELECT is_qa_fixture
        FROM task_quality_signals
        WHERE task_id = ${fixture.taskId}
      `;
      expect(fixtureSignal?.is_qa_fixture).toBe(true);
      throw new Error("simulate QA browser failure");
    }, { hiveId: HIVE, runId: "qa-smoke-failure-cleanup" })).rejects.toThrow("simulate QA browser failure");

    const [realSignalCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM task_quality_signals
      WHERE task_id = ${TASK}
        AND is_qa_fixture = false
    `;
    expect(realSignalCount.count).toBe(1);

    const [fixtureDecisionCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM decisions
      WHERE is_qa_fixture = true
        AND options #>> '{qa,runId}' = 'qa-smoke-failure-cleanup'
    `;
    const [fixtureSignalCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM task_quality_signals
      WHERE is_qa_fixture = true
    `;
    expect(fixtureDecisionCount.count).toBe(0);
    expect(fixtureSignalCount.count).toBe(0);
  });
});
