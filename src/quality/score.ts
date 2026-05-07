import type { Sql } from "postgres";

export interface RoleQualityScore {
  hiveId: string;
  roleSlug: string;
  qualityScore: number;
  basis:
    | "composite"
    | "completion_fallback"
    | "sparse_default";
  components: {
    explicitRating?: number;
    implicitSignal?: number;
    qaCleanFirstPass?: number;
    doctorPenalty?: number;
    completionFallback?: number;
  };
  sample: {
    explicitRatings: number;
    implicitSignals: number;
    completedTasks: number;
    terminalTasks: number;
    doctorInvocations: number;
  };
}

export const SPARSE_QUALITY_SCORE = 0.7;

export async function calculateRoleQualityScore(
  sql: Sql,
  hiveId: string,
  roleSlug: string,
): Promise<RoleQualityScore> {
  return calculateRoleQualityScoreScoped(sql, hiveId, roleSlug);
}

export async function calculateRoleQualityScoreForTaskIds(
  sql: Sql,
  hiveId: string,
  roleSlug: string,
  taskIds: string[],
): Promise<RoleQualityScore> {
  return calculateRoleQualityScoreScoped(sql, hiveId, roleSlug, taskIds);
}

async function calculateRoleQualityScoreScoped(
  sql: Sql,
  hiveId: string,
  roleSlug: string,
  taskIds?: string[],
): Promise<RoleQualityScore> {
  const scopedTaskIds = taskIds && taskIds.length > 0 ? taskIds : null;
  const signalTaskScope = scopedTaskIds ? sql`AND t.id = ANY(${scopedTaskIds})` : sql``;
  const taskScope = scopedTaskIds ? sql`AND id = ANY(${scopedTaskIds})` : sql``;
  const [explicit] = await sql<{ score: number | null; count: number }[]>`
    SELECT AVG(rating / 10.0)::float AS score,
           COUNT(*)::int AS count
    FROM task_quality_signals s
    JOIN tasks t ON t.id = s.task_id
    WHERE s.hive_id = ${hiveId}::uuid
      AND t.hive_id = ${hiveId}::uuid
      AND t.assigned_to = ${roleSlug}
      ${signalTaskScope}
      AND s.source = 'explicit_owner_feedback'
      AND s.rating IS NOT NULL
      AND s.is_qa_fixture = false
  `;

  const [implicit] = await sql<{ score: number | null; count: number }[]>`
    SELECT
      CASE WHEN SUM(confidence) > 0 THEN
        (
          SUM(
            CASE signal_type
              WHEN 'positive' THEN 1.0
              WHEN 'neutral' THEN 0.5
              ELSE 0.0
            END * confidence
          ) / SUM(confidence)
        )::float
      ELSE NULL END AS score,
      COUNT(*)::int AS count
    FROM task_quality_signals s
    JOIN tasks t ON t.id = s.task_id
    WHERE s.hive_id = ${hiveId}::uuid
      AND t.hive_id = ${hiveId}::uuid
      AND t.assigned_to = ${roleSlug}
      ${signalTaskScope}
      AND s.source = 'implicit_ea'
      AND s.is_qa_fixture = false
  `;

  const [tasks] = await sql<{
    terminal: number;
    completed: number;
    clean_completed: number;
    doctor_invocations: number;
  }[]>`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('completed','failed','unresolvable'))::int AS terminal,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
      COUNT(*) FILTER (
        WHERE status = 'completed'
          AND COALESCE(retry_count, 0) = 0
          AND COALESCE(doctor_attempts, 0) = 0
      )::int AS clean_completed,
      COALESCE(SUM(COALESCE(doctor_attempts, 0)), 0)::int AS doctor_invocations
    FROM tasks
    WHERE hive_id = ${hiveId}::uuid
      AND assigned_to = ${roleSlug}
      ${taskScope}
      AND COALESCE(started_at, completed_at, updated_at, created_at) > NOW() - INTERVAL '60 days'
  `;

  const components: RoleQualityScore["components"] = {};
  const weighted: { value: number; weight: number }[] = [];

  if (Number(explicit.count) > 0 && explicit.score !== null) {
    components.explicitRating = clamp01(Number(explicit.score));
    weighted.push({ value: components.explicitRating, weight: 4 });
  }
  if (Number(implicit.count) > 0 && implicit.score !== null) {
    components.implicitSignal = clamp01(Number(implicit.score));
    weighted.push({ value: components.implicitSignal, weight: 3 });
  }
  if (Number(tasks.completed) > 0) {
    components.qaCleanFirstPass = clamp01(Number(tasks.clean_completed) / Number(tasks.completed));
    weighted.push({ value: components.qaCleanFirstPass, weight: 2 });

    const doctorRate = Number(tasks.doctor_invocations) / Number(tasks.completed);
    components.doctorPenalty = clamp01(1 - doctorRate);
    weighted.push({ value: components.doctorPenalty, weight: 1.5 });
  }

  let basis: RoleQualityScore["basis"];
  let qualityScore: number;
  if (weighted.length > 0) {
    basis = "composite";
    const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
    qualityScore = weighted.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight;
  } else if (Number(tasks.terminal) > 0) {
    basis = "completion_fallback";
    components.completionFallback = clamp01(Number(tasks.completed) / Number(tasks.terminal));
    qualityScore = components.completionFallback;
  } else {
    basis = "sparse_default";
    qualityScore = SPARSE_QUALITY_SCORE;
  }

  return {
    hiveId,
    roleSlug,
    qualityScore: roundScore(qualityScore),
    basis,
    components,
    sample: {
      explicitRatings: Number(explicit.count),
      implicitSignals: Number(implicit.count),
      completedTasks: Number(tasks.completed),
      terminalTasks: Number(tasks.terminal),
      doctorInvocations: Number(tasks.doctor_invocations),
    },
  };
}

export async function listRoleQualityScores(
  sql: Sql,
  hiveId: string,
): Promise<RoleQualityScore[]> {
  const roles = await sql<{ slug: string }[]>`
    SELECT DISTINCT rt.slug
    FROM role_templates rt
    LEFT JOIN tasks t ON t.assigned_to = rt.slug AND t.hive_id = ${hiveId}::uuid
    WHERE rt.active = true
    ORDER BY rt.slug
  `;

  return Promise.all(roles.map((role) => calculateRoleQualityScore(sql, hiveId, role.slug)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}
