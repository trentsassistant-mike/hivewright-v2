import type { Sql } from "postgres";

export interface StandingInstruction {
  id: string;
  hiveId: string;
  content: string;
  affectedDepartments: string[];
  sourceInsightId: string | null;
  confidence: number;
  createdAt: Date;
  reviewAt: Date | null;
}

/**
 * Finds insights eligible for promotion to standing instructions.
 * Qualifying criteria:
 *  - confidence >= 0.85
 *  - status in ('reviewed', 'actioned')
 *  - affects 2 or more departments
 *  - not already promoted (no matching standing_instruction row)
 */
export async function checkForPromotableInsights(
  sql: Sql,
  hiveId: string,
): Promise<{ id: string; content: string; confidence: number; affectedDepartments: string[] }[]> {
  const rows = await sql`
    SELECT i.id, i.content, i.confidence, i.affected_departments
    FROM insights i
    WHERE i.hive_id = ${hiveId}
      AND i.confidence >= 0.85
      AND i.status IN ('reviewed', 'actioned')
      AND jsonb_array_length(i.affected_departments) >= 2
      AND NOT EXISTS (
        SELECT 1 FROM standing_instructions si
        WHERE si.source_insight_id = i.id
      )
    ORDER BY i.confidence DESC, i.created_at ASC
  `;

  return rows.map((r) => ({
    id: r.id as string,
    content: r.content as string,
    confidence: r.confidence as number,
    affectedDepartments: (r.affected_departments ?? []) as string[],
  }));
}

/**
 * Promotes an insight to a standing instruction.
 * Sets review_at to 90 days from now and marks the insight as 'actioned'.
 */
export async function promoteInsightToInstruction(
  sql: Sql,
  insightId: string,
): Promise<StandingInstruction> {
  // Fetch the source insight
  const [insight] = await sql`
    SELECT id, hive_id, content, confidence, affected_departments
    FROM insights
    WHERE id = ${insightId}
  `;

  if (!insight) {
    throw new Error(`Insight not found: ${insightId}`);
  }

  const reviewAt = new Date();
  reviewAt.setDate(reviewAt.getDate() + 90);

  const [row] = await sql`
    INSERT INTO standing_instructions (
      hive_id,
      content,
      affected_departments,
      source_insight_id,
      confidence,
      review_at
    ) VALUES (
      ${insight.hive_id},
      ${insight.content},
      ${sql.json(insight.affected_departments ?? [])},
      ${insightId},
      ${insight.confidence as number},
      ${reviewAt}
    )
    RETURNING *
  `;

  // Mark the insight as actioned
  await sql`
    UPDATE insights SET status = 'actioned', updated_at = NOW()
    WHERE id = ${insightId}
  `;

  return {
    id: row.id as string,
    hiveId: row.hive_id as string,
    content: row.content as string,
    affectedDepartments: (row.affected_departments ?? []) as string[],
    sourceInsightId: row.source_insight_id as string | null,
    confidence: row.confidence as number,
    createdAt: new Date(row.created_at as string),
    reviewAt: row.review_at ? new Date(row.review_at as string) : null,
  };
}

/**
 * Loads standing instructions for a hive, optionally filtered to a department.
 * Uses jsonb @> containment operator for department matching.
 * If department is null, returns all instructions for the hive.
 */
export async function loadStandingInstructions(
  sql: Sql,
  hiveId: string,
  department: string | null,
): Promise<StandingInstruction[]> {
  const rows =
    department !== null
      ? await sql`
          SELECT *
          FROM standing_instructions
          WHERE hive_id = ${hiveId}
            AND affected_departments @> ${sql.json([department])}
          ORDER BY confidence DESC, created_at ASC
        `
      : await sql`
          SELECT *
          FROM standing_instructions
          WHERE hive_id = ${hiveId}
          ORDER BY confidence DESC, created_at ASC
        `;

  return rows.map((r) => ({
    id: r.id as string,
    hiveId: r.hive_id as string,
    content: r.content as string,
    affectedDepartments: (r.affected_departments ?? []) as string[],
    sourceInsightId: r.source_insight_id as string | null,
    confidence: r.confidence as number,
    createdAt: new Date(r.created_at as string),
    reviewAt: r.review_at ? new Date(r.review_at as string) : null,
  }));
}
