import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { classifyInsight, runInsightCurator } from "@/insights/curator";

let hiveId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('curator-test', 'Curator Test', 'digital')
    RETURNING id
  `;
  hiveId = biz.id as string;
});

async function insertInsight(opts: {
  content?: string;
  connectionType?: string;
  confidence?: number;
  affectedDepartments?: string[];
  priority?: string;
}): Promise<string> {
  const [row] = await sql`
    INSERT INTO insights (
      hive_id, content, connection_type, confidence,
      affected_departments, source_work_products,
      max_source_sensitivity, status, priority
    ) VALUES (
      ${hiveId},
      ${opts.content ?? "test insight"},
      ${opts.connectionType ?? "reinforcing"},
      ${opts.confidence ?? 0.7},
      ${sql.json(opts.affectedDepartments ?? [])},
      ${sql.json([])},
      'internal',
      'new',
      ${opts.priority ?? "medium"}
    )
    RETURNING id
  `;
  return row.id as string;
}

describe("classifyInsight", () => {
  it("escalates high-confidence risks", () => {
    const d = classifyInsight({
      id: "x",
      hiveId,
      content: "x",
      connectionType: "risk",
      confidence: 0.92,
      affectedDepartments: ["eng", "ops"],
      priority: "high",
    });
    expect(d.kind).toBe("escalate");
  });

  it("promotes high-confidence multi-department non-risk", () => {
    const d = classifyInsight({
      id: "x",
      hiveId,
      content: "x",
      connectionType: "opportunity",
      confidence: 0.88,
      affectedDepartments: ["eng", "sales"],
      priority: "high",
    });
    expect(d.kind).toBe("promote");
  });

  it("dismisses low-confidence insights", () => {
    const d = classifyInsight({
      id: "x",
      hiveId,
      content: "x",
      connectionType: "reinforcing",
      confidence: 0.4,
      affectedDepartments: ["eng"],
      priority: "low",
    });
    expect(d.kind).toBe("dismiss");
  });

  it("acknowledges middle-bucket single-department insights", () => {
    const d = classifyInsight({
      id: "x",
      hiveId,
      content: "x",
      connectionType: "reinforcing",
      confidence: 0.75,
      affectedDepartments: ["eng"],
      priority: "medium",
    });
    expect(d.kind).toBe("acknowledge");
  });

  it("does not promote when high-confidence but only one department", () => {
    const d = classifyInsight({
      id: "x",
      hiveId,
      content: "x",
      connectionType: "opportunity",
      confidence: 0.95,
      affectedDepartments: ["eng"],
      priority: "high",
    });
    expect(d.kind).toBe("acknowledge");
  });
});

describe("runInsightCurator", () => {
  it("processes the full inbox in one pass", async () => {
    await insertInsight({
      connectionType: "risk",
      confidence: 0.95,
      affectedDepartments: ["security"],
      priority: "high",
    });
    await insertInsight({
      connectionType: "opportunity",
      confidence: 0.9,
      affectedDepartments: ["eng", "sales"],
    });
    await insertInsight({ connectionType: "reinforcing", confidence: 0.3 });
    await insertInsight({ connectionType: "reinforcing", confidence: 0.7 });

    const result = await runInsightCurator(sql, hiveId);
    expect(result.escalated).toBe(1);
    expect(result.promoted).toBe(1);
    expect(result.dismissed).toBe(1);
    expect(result.acknowledged).toBe(1);

    const stillNew = await sql`SELECT COUNT(*)::int AS c FROM insights WHERE status = 'new'`;
    expect(stillNew[0].c).toBe(0);
  });

  it("creates a decision row for escalations and links it back", async () => {
    const id = await insertInsight({
      connectionType: "risk",
      confidence: 0.93,
      affectedDepartments: ["security", "ops"],
      priority: "high",
      content: "Storing API keys in env files exposes them to leak via process listings.",
    });
    await runInsightCurator(sql, hiveId);

    const [insight] = await sql`
      SELECT status, decision_id, curator_reason FROM insights WHERE id = ${id}
    `;
    expect(insight.status).toBe("escalated");
    expect(insight.decision_id).not.toBeNull();
    expect(insight.curator_reason).toContain("Risk at");

    const [decision] = await sql`
      SELECT title, status, options FROM decisions WHERE id = ${insight.decision_id}
    `;
    expect(decision.status).toBe("ea_review");
    expect(decision.title).toContain("Risk insight needs review");
    expect(decision.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "promote_insight" }),
        expect.objectContaining({ action: "dismiss_insight" }),
      ]),
    );
  });

  it("creates a standing_instructions row for promotions", async () => {
    await insertInsight({
      connectionType: "opportunity",
      confidence: 0.91,
      affectedDepartments: ["eng", "sales", "ops"],
      content: "Cross-team standups would close a feedback gap.",
    });
    await runInsightCurator(sql, hiveId);

    const standing = await sql`SELECT * FROM standing_instructions WHERE hive_id = ${hiveId}`;
    expect(standing).toHaveLength(1);
    expect(standing[0].content).toContain("Cross-team standups");
  });

  it("is idempotent — re-running on the same hive does nothing because no insight is 'new' anymore", async () => {
    await insertInsight({ connectionType: "reinforcing", confidence: 0.7 });
    const first = await runInsightCurator(sql, hiveId);
    expect(first.acknowledged).toBe(1);

    const second = await runInsightCurator(sql, hiveId);
    expect(second.acknowledged).toBe(0);
    expect(second.promoted).toBe(0);
    expect(second.escalated).toBe(0);
    expect(second.dismissed).toBe(0);
  });
});
