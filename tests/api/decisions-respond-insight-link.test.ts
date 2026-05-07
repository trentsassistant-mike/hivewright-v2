import { describe, it, expect, beforeEach } from "vitest";
import { POST as respondToDecision } from "@/app/api/decisions/[id]/respond/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('decisions-respond-link-test', 'Decisions Respond Link Test', 'digital')
    RETURNING id
  `;
  hiveId = biz.id as string;
});

async function setupEscalatedPair(): Promise<{ insightId: string; decisionId: string }> {
  const [insight] = await sql`
    INSERT INTO insights (
      hive_id, content, connection_type, confidence,
      affected_departments, source_work_products,
      max_source_sensitivity, status, priority
    ) VALUES (
      ${hiveId},
      'Test risk insight for cross-link',
      'risk',
      0.92,
      ${sql.json(["security", "ops"])},
      ${sql.json([])},
      'internal',
      'escalated',
      'high'
    )
    RETURNING id
  `;
  const [decision] = await sql`
    INSERT INTO decisions (hive_id, title, context, recommendation, options, priority, status)
    VALUES (
      ${hiveId},
      'Risk insight needs review: x',
      'context',
      'Promote, dismiss, or act',
      ${sql.json([
        { label: "Promote to standing instruction", action: "promote_insight" },
        { label: "Dismiss as not actionable", action: "dismiss_insight" },
      ])},
      'high',
      'pending'
    )
    RETURNING id
  `;
  await sql`
    UPDATE insights SET decision_id = ${decision.id} WHERE id = ${insight.id}
  `;
  return { insightId: insight.id as string, decisionId: decision.id as string };
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

describe("POST /api/decisions/[id]/respond — insight propagation", () => {
  it("approving an insight-linked decision promotes the insight to actioned + creates a standing instruction", async () => {
    const { insightId, decisionId } = await setupEscalatedPair();

    const res = await respondReq(decisionId, {
      response: "approved",
      comment: "Real risk, promote it",
    });
    expect(res.status).toBe(200);

    const [insight] = await sql`SELECT status, curator_reason FROM insights WHERE id = ${insightId}`;
    expect(insight.status).toBe("actioned");
    expect(insight.curator_reason).toContain("approved");
    expect(insight.curator_reason).toContain("Real risk");

    const standing = await sql`SELECT id FROM standing_instructions WHERE source_insight_id = ${insightId}`;
    expect(standing).toHaveLength(1);
  });

  it("rejecting an insight-linked decision dismisses the insight", async () => {
    const { insightId, decisionId } = await setupEscalatedPair();

    const res = await respondReq(decisionId, {
      response: "rejected",
      comment: "False positive",
    });
    expect(res.status).toBe(200);

    const [insight] = await sql`SELECT status, curator_reason FROM insights WHERE id = ${insightId}`;
    expect(insight.status).toBe("dismissed");
    expect(insight.curator_reason).toContain("rejected");
    expect(insight.curator_reason).toContain("False positive");

    const standing = await sql`SELECT id FROM standing_instructions WHERE source_insight_id = ${insightId}`;
    expect(standing).toHaveLength(0);
  });

  it("discussing does not change the linked insight (decision stays open)", async () => {
    const { insightId, decisionId } = await setupEscalatedPair();

    await respondReq(decisionId, { response: "discussed", comment: "thinking" });

    const [insight] = await sql`SELECT status FROM insights WHERE id = ${insightId}`;
    expect(insight.status).toBe("escalated");
  });

  it("approving a decision with no linked insight is a no-op for insights", async () => {
    const [decision] = await sql`
      INSERT INTO decisions (hive_id, title, context, priority, status)
      VALUES (${hiveId}, 'unrelated', 'ctx', 'normal', 'pending')
      RETURNING id
    `;
    const res = await respondReq(decision.id as string, { response: "approved" });
    expect(res.status).toBe(200);
  });
});
