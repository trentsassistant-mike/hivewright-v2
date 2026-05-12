export function ideaRowToApi(row: Record<string, unknown>) {
  return {
    id: row.id,
    hiveId: row.hive_id,
    title: row.title,
    body: row.body,
    createdBy: row.created_by,
    status: row.status,
    reviewedAt: row.reviewed_at,
    aiAssessment: row.ai_assessment,
    promotedToGoalId: row.promoted_to_goal_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
