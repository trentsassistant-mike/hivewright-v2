import type { Sql } from "postgres";

export interface GoalDocument {
  id: string;
  goalId: string;
  documentType: string;
  title: string;
  format: string;
  body: string;
  revision: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertPlanInput {
  title: string;
  body: string;
  createdBy: string;
}

function toDocument(row: Record<string, unknown>): GoalDocument {
  return {
    id: row.id as string,
    goalId: row.goal_id as string,
    documentType: row.document_type as string,
    title: row.title as string,
    format: row.format as string,
    body: row.body as string,
    revision: row.revision as number,
    createdBy: row.created_by as string,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Insert or update the plan document for a goal. On update, bumps `revision`.
 * Only one row per (goal_id, 'plan') exists at any time.
 */
export async function upsertGoalPlan(
  sql: Sql,
  goalId: string,
  input: UpsertPlanInput,
): Promise<GoalDocument> {
  const [row] = await sql`
    INSERT INTO goal_documents (goal_id, document_type, title, format, body, revision, created_by)
    VALUES (${goalId}, 'plan', ${input.title}, 'markdown', ${input.body}, 1, ${input.createdBy})
    ON CONFLICT (goal_id, document_type) DO UPDATE
      SET title = EXCLUDED.title,
          body = EXCLUDED.body,
          revision = goal_documents.revision + 1,
          updated_at = NOW()
    RETURNING *
  `;
  return toDocument(row);
}

/** Returns the current plan document for a goal, or null if none. */
export async function getGoalPlan(
  sql: Sql,
  goalId: string,
): Promise<GoalDocument | null> {
  const rows = await sql`
    SELECT * FROM goal_documents
    WHERE goal_id = ${goalId} AND document_type = 'plan'
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return toDocument(rows[0]);
}

/** Lists all documents belonging to a goal, newest first. */
export async function listGoalDocuments(
  sql: Sql,
  goalId: string,
): Promise<GoalDocument[]> {
  const rows = await sql`
    SELECT * FROM goal_documents
    WHERE goal_id = ${goalId}
    ORDER BY updated_at DESC
  `;
  return rows.map(toDocument);
}
