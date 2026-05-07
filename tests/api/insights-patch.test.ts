import { describe, it, expect, beforeEach } from "vitest";
import { PATCH as patchInsight } from "@/app/api/insights/[id]/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let hiveId: string;

beforeEach(async () => {
  await truncateAll(sql);
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('insights-patch-test', 'Insights Patch Test', 'digital')
    RETURNING id
  `;
  hiveId = biz.id as string;
});

async function insertInsight(opts: {
  status?: string;
  affectedDepartments?: string[];
  confidence?: number;
}): Promise<string> {
  const [row] = await sql`
    INSERT INTO insights (
      hive_id, content, connection_type, confidence,
      affected_departments, source_work_products,
      max_source_sensitivity, status, priority
    ) VALUES (
      ${hiveId},
      'Test insight content',
      'opportunity',
      ${opts.confidence ?? 0.8},
      ${sql.json(opts.affectedDepartments ?? ["eng", "ops"])},
      ${sql.json([])},
      'internal',
      ${opts.status ?? "new"},
      'medium'
    )
    RETURNING id
  `;
  return row.id as string;
}

function patchReq(id: string, body: object) {
  return patchInsight(
    new Request(`http://localhost/api/insights/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("PATCH /api/insights/[id]", () => {
  it("dismisses an insight and writes an Owner override reason", async () => {
    const id = await insertInsight({ status: "acknowledged" });

    const res = await patchReq(id, { status: "dismissed", note: "not a real risk" });
    expect(res.status).toBe(200);

    const [row] = await sql`SELECT status, curator_reason FROM insights WHERE id = ${id}`;
    expect(row.status).toBe("dismissed");
    expect(row.curator_reason).toContain("Owner override");
    expect(row.curator_reason).toContain("not a real risk");
  });

  it("creates a standing instruction when status transitions to actioned", async () => {
    const id = await insertInsight({});

    const res = await patchReq(id, { status: "actioned" });
    expect(res.status).toBe(200);

    const standing = await sql`
      SELECT id FROM standing_instructions WHERE source_insight_id = ${id}
    `;
    expect(standing).toHaveLength(1);

    const [row] = await sql`SELECT status FROM insights WHERE id = ${id}`;
    expect(row.status).toBe("actioned");
  });

  it("does not double-create a standing instruction when actioned twice", async () => {
    const id = await insertInsight({});
    await patchReq(id, { status: "actioned" });
    await patchReq(id, { status: "actioned", note: "re-confirmed" });

    const standing = await sql`
      SELECT id FROM standing_instructions WHERE source_insight_id = ${id}
    `;
    expect(standing).toHaveLength(1);
  });

  it("returns 400 for an unknown status", async () => {
    const id = await insertInsight({});
    const res = await patchReq(id, { status: "frobnicated" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown insight id", async () => {
    const res = await patchReq(
      "00000000-0000-0000-0000-000000000000",
      { status: "dismissed" },
    );
    expect(res.status).toBe(404);
  });

  it("auto-resolves the linked decision when an escalated insight is acted on", async () => {
    // Set up an escalated insight pointing at a pending decision (mirrors what
    // the curator does when it escalates a high-confidence risk).
    const id = await insertInsight({ status: "escalated" });
    const [decision] = await sql`
      INSERT INTO decisions (hive_id, title, context, priority, status)
      VALUES (${hiveId}, 'Risk insight needs review: x', 'context', 'high', 'pending')
      RETURNING id
    `;
    await sql`UPDATE insights SET decision_id = ${decision.id} WHERE id = ${id}`;

    const res = await patchReq(id, { status: "dismissed", note: "false positive" });
    expect(res.status).toBe(200);

    const [d] = await sql`
      SELECT status, owner_response, resolved_at FROM decisions WHERE id = ${decision.id}
    `;
    expect(d.status).toBe("resolved");
    expect(d.owner_response).toContain("dismissed");
    expect(d.owner_response).toContain("false positive");
    expect(d.resolved_at).not.toBeNull();
  });

  it("does not touch decisions when the insight has no linked decision_id", async () => {
    const id = await insertInsight({ status: "acknowledged" });
    // No decision row at all — make sure PATCH still succeeds and doesn't error
    // trying to UPDATE a null decision id.
    const res = await patchReq(id, { status: "dismissed" });
    expect(res.status).toBe(200);
  });
});
