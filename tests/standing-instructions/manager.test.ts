import { describe, it, expect, beforeEach } from "vitest";
import {
  checkForPromotableInsights,
  promoteInsightToInstruction,
  loadStandingInstructions,
} from "@/standing-instructions/manager";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const PREFIX = "p6-si-";
let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('p6-si-test', 'P6 SI Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;
});

// Helper: insert an insight with given fields
async function insertInsight({
  content,
  confidence,
  status,
  affectedDepartments,
}: {
  content: string;
  confidence: number;
  status: string;
  affectedDepartments: string[];
}): Promise<string> {
  const [row] = await sql`
    INSERT INTO insights (
      hive_id, content, connection_type, confidence,
      affected_departments, source_work_products,
      max_source_sensitivity, status, priority
    ) VALUES (
      ${bizId},
      ${content},
      'reinforcing',
      ${confidence},
      ${sql.json(affectedDepartments)},
      ${sql.json([])},
      'internal',
      ${status},
      'medium'
    )
    RETURNING id
  `;
  return row.id as string;
}

describe("promoteInsightToInstruction", () => {
  it("creates a standing instruction from an insight", async () => {
    const insightId = await insertInsight({
      content: PREFIX + "cross-dept insight for promotion",
      confidence: 0.9,
      status: "reviewed",
      affectedDepartments: ["engineering", "marketing"],
    });

    const instruction = await promoteInsightToInstruction(sql, insightId);

    expect(instruction.id).toBeTruthy();
    expect(instruction.hiveId).toBe(bizId);
    expect(instruction.content).toBe(PREFIX + "cross-dept insight for promotion");
    expect(instruction.sourceInsightId).toBe(insightId);
    expect(instruction.confidence).toBeCloseTo(0.9, 2);
    expect(instruction.affectedDepartments).toEqual(
      expect.arrayContaining(["engineering", "marketing"])
    );
    expect(instruction.reviewAt).toBeInstanceOf(Date);

    // review_at should be ~90 days from now
    const daysUntilReview =
      (instruction.reviewAt!.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(daysUntilReview).toBeGreaterThan(88);
    expect(daysUntilReview).toBeLessThan(92);

    // The insight should be marked as actioned
    const [updated] = await sql`SELECT status FROM insights WHERE id = ${insightId}`;
    expect(updated.status).toBe("actioned");
  });
});

describe("loadStandingInstructions", () => {
  it("returns instructions for a matching department", async () => {
    const insightId = await insertInsight({
      content: PREFIX + "instruction for engineering dept",
      confidence: 0.9,
      status: "reviewed",
      affectedDepartments: ["engineering", "ops"],
    });
    await promoteInsightToInstruction(sql, insightId);

    const results = await loadStandingInstructions(sql, bizId, "engineering");
    expect(results.length).toBe(1);
    expect(results[0].content).toBe(PREFIX + "instruction for engineering dept");
    expect(results[0].affectedDepartments).toContain("engineering");
  });

  it("excludes instructions from other departments", async () => {
    const insightId = await insertInsight({
      content: PREFIX + "instruction for ops only",
      confidence: 0.92,
      status: "reviewed",
      affectedDepartments: ["ops", "finance"],
    });
    await promoteInsightToInstruction(sql, insightId);

    // Query for engineering — should get nothing
    const results = await loadStandingInstructions(sql, bizId, "engineering");
    expect(results.length).toBe(0);
  });
});

describe("checkForPromotableInsights", () => {
  it("finds qualifying insights", async () => {
    // Qualifying: confidence >= 0.85, status reviewed/actioned, 2+ departments, not already promoted
    const qualId = await insertInsight({
      content: PREFIX + "qualifying insight",
      confidence: 0.88,
      status: "reviewed",
      affectedDepartments: ["marketing", "finance"],
    });

    // Non-qualifying: low confidence
    await insertInsight({
      content: PREFIX + "low confidence insight",
      confidence: 0.5,
      status: "reviewed",
      affectedDepartments: ["marketing", "finance"],
    });

    // Non-qualifying: wrong status
    await insertInsight({
      content: PREFIX + "new status insight",
      confidence: 0.9,
      status: "new",
      affectedDepartments: ["marketing", "finance"],
    });

    // Non-qualifying: only 1 department
    await insertInsight({
      content: PREFIX + "single dept insight",
      confidence: 0.9,
      status: "reviewed",
      affectedDepartments: ["marketing"],
    });

    const promotable = await checkForPromotableInsights(sql, bizId);
    const ids = promotable.map((p) => p.id);
    expect(ids).toContain(qualId);

    // Already promoted insight should not appear
    await promoteInsightToInstruction(sql, qualId);
    const afterPromotion = await checkForPromotableInsights(sql, bizId);
    const afterIds = afterPromotion.map((p) => p.id);
    expect(afterIds).not.toContain(qualId);
  });
});
