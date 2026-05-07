import type { Sql } from "postgres";
import {
  loadOwnerFeedbackSamplingConfig,
  type OwnerFeedbackSamplingConfig,
} from "./owner-feedback-config";
import {
  classifyQualityFeedbackLane,
  type QualityFeedbackLane,
} from "./feedback-lane-classifier";

export const TASK_QUALITY_FEEDBACK_DECISION_KIND = "task_quality_feedback";
export const TASK_QUALITY_FEEDBACK_SCHEDULE_KIND = "task-quality-feedback-sample";

export interface OwnerFeedbackSweepResult {
  hiveId: string;
  eligible: number;
  sampled: number;
  decisionsCreated: number;
  ownerDecisionsCreated: number;
  aiPeerDecisionsCreated: number;
  aiPeerReviewTasksCreated: number;
  reclassifiedPending: number;
}

export interface OwnerFeedbackSampleCandidate {
  taskId: string;
  hiveId: string;
  goalId: string | null;
  title: string;
  brief: string;
  roleSlug: string;
  completedAt: Date;
  workProductId: string | null;
  workProductSummary: string | null;
}

export interface OwnerFeedbackSweepOptions {
  hiveId?: string;
  now?: Date;
  random?: () => number;
  config?: OwnerFeedbackSamplingConfig;
}

export async function runOwnerFeedbackSampleSweep(
  sql: Sql,
  options: OwnerFeedbackSweepOptions = {},
): Promise<OwnerFeedbackSweepResult[]> {
  const hives = options.hiveId
    ? [{ id: options.hiveId }]
    : await sql<{ id: string }[]>`SELECT id FROM hives`;
  const results: OwnerFeedbackSweepResult[] = [];

  for (const hive of hives) {
    const result = await runOwnerFeedbackSampleSweepForHive(sql, hive.id, options);
    results.push(result);
  }

  return results;
}

export async function runOwnerFeedbackSampleSweepForHive(
  sql: Sql,
  hiveId: string,
  options: OwnerFeedbackSweepOptions = {},
): Promise<OwnerFeedbackSweepResult> {
  const config = options.config ?? await loadOwnerFeedbackSamplingConfig(sql, hiveId);
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;
  const reclassifiedPending = await reclassifyPendingQualityFeedback(sql, hiveId);
  const candidates = await findOwnerFeedbackSampleCandidates(sql, hiveId, config, now);
  const caps = await loadDailyCaps(sql, hiveId, now);

  let sampled = 0;
  let decisionsCreated = 0;
  let ownerDecisionsCreated = 0;
  let aiPeerDecisionsCreated = 0;
  let aiPeerReviewTasksCreated = 0;
  const createdByRole = new Map<string, number>();

  for (const candidate of candidates) {
    const classification = classifyQualityFeedbackLane(candidate);
    const sampleRate = classification.lane === "owner"
      ? config.sampleRate
      : config.aiPeerReviewSampleRate;
    if (random() >= sampleRate) continue;
    sampled++;

    if (classification.lane === "ai_peer") {
      const created = await createAiPeerFeedbackDecision(sql, candidate, classification.reason);
      if (created.decisionCreated) {
        decisionsCreated++;
        aiPeerDecisionsCreated++;
      }
      if (created.reviewTaskCreated) aiPeerReviewTasksCreated++;
      continue;
    }

    const totalForDay = caps.total + ownerDecisionsCreated;
    if (totalForDay >= config.perDayCap) break;

    const existingForRole = caps.byRole.get(candidate.roleSlug) ?? 0;
    const newForRole = createdByRole.get(candidate.roleSlug) ?? 0;
    if (existingForRole + newForRole >= config.perRoleDailyCap) continue;

    const created = await createOwnerFeedbackDecision(sql, candidate, classification.reason);
    if (created) {
      decisionsCreated++;
      ownerDecisionsCreated++;
      createdByRole.set(candidate.roleSlug, newForRole + 1);
    }
  }

  return {
    hiveId,
    eligible: candidates.length,
    sampled,
    decisionsCreated,
    ownerDecisionsCreated,
    aiPeerDecisionsCreated,
    aiPeerReviewTasksCreated,
    reclassifiedPending,
  };
}

export async function findOwnerFeedbackSampleCandidates(
  sql: Sql,
  hiveId: string,
  config: Pick<OwnerFeedbackSamplingConfig, "eligibilityWindowDays" | "duplicateCooldownDays">,
  now = new Date(),
): Promise<OwnerFeedbackSampleCandidate[]> {
  const rows = await sql<OwnerFeedbackSampleCandidate[]>`
    SELECT
      t.id AS "taskId",
      t.hive_id AS "hiveId",
      t.goal_id AS "goalId",
      t.title,
      t.brief,
      t.assigned_to AS "roleSlug",
      t.completed_at AS "completedAt",
      wp.id AS "workProductId",
      COALESCE(wp.summary, left(wp.content, 240)) AS "workProductSummary"
    FROM tasks t
    LEFT JOIN LATERAL (
      SELECT id, summary, content
      FROM work_products
      WHERE task_id = t.id
        AND hive_id = t.hive_id
      ORDER BY created_at DESC
      LIMIT 1
    ) wp ON true
    WHERE t.hive_id = ${hiveId}::uuid
      AND t.status = 'completed'
      AND t.completed_at IS NOT NULL
      AND t.completed_at >= ${now}::timestamp - (${config.eligibilityWindowDays}::int * interval '1 day')
      AND t.completed_at <= ${now}::timestamp
      AND COALESCE(t.retry_count, 0) <= 1
      AND (
        wp.id IS NOT NULL
        OR length(COALESCE(t.result_summary, '')) >= 80
      )
      AND NOT EXISTS (
        SELECT 1
        FROM decisions d
        WHERE d.hive_id = t.hive_id
          AND d.task_id = t.id
          AND d.kind = ${TASK_QUALITY_FEEDBACK_DECISION_KIND}
          AND (
            d.created_at >= ${now}::timestamp - (${config.duplicateCooldownDays}::int * interval '1 day')
            OR d.status IN ('pending', 'ea_review')
          )
      )
    ORDER BY t.completed_at DESC, t.id ASC
  `;

  return rows;
}

async function loadDailyCaps(
  sql: Sql,
  hiveId: string,
  now: Date,
): Promise<{ total: number; byRole: Map<string, number> }> {
  const rows = await sql<{ role_slug: string | null; count: number }[]>`
    SELECT options #>> '{task,role}' AS role_slug,
           COUNT(*)::int AS count
    FROM decisions
    WHERE hive_id = ${hiveId}::uuid
      AND kind = ${TASK_QUALITY_FEEDBACK_DECISION_KIND}
      AND COALESCE(options #>> '{lane}', 'owner') = 'owner'
      AND created_at >= date_trunc('day', ${now}::timestamp)
      AND created_at < date_trunc('day', ${now}::timestamp) + interval '1 day'
    GROUP BY options #>> '{task,role}'
  `;

  const byRole = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    total += Number(row.count);
    if (row.role_slug) byRole.set(row.role_slug, Number(row.count));
  }
  return { total, byRole };
}

async function createOwnerFeedbackDecision(
  sql: Sql,
  candidate: OwnerFeedbackSampleCandidate,
  classificationReason: string,
): Promise<boolean> {
  const title = `Task quality check: ${candidate.title}`;
  const completedDate = candidate.completedAt.toISOString();
  const workProductReference = candidate.workProductId
    ? `/tasks?taskId=${candidate.taskId}#work-product-${candidate.workProductId}`
    : null;
  const options = {
    kind: TASK_QUALITY_FEEDBACK_DECISION_KIND,
    lane: "owner" satisfies QualityFeedbackLane,
    provenance: "owner_feedback_sampler",
    classificationReason,
    responseModel: "quality_rating_v1",
    task: {
      id: candidate.taskId,
      title: candidate.title,
      role: candidate.roleSlug,
      completedAt: completedDate,
      workProductId: candidate.workProductId,
      workProductReference,
    },
    fields: [
      { name: "rating", type: "integer", min: 1, max: 10, required: true },
      { name: "comment", type: "text", required: false },
    ],
    options: [
      { label: "No opinion / dismiss", action: "dismiss_quality_feedback" },
    ],
  };

  const context = buildFeedbackContext(candidate, completedDate, workProductReference);

  const rows = await sql<{ id: string }[]>`
    INSERT INTO decisions (
      hive_id, goal_id, task_id, title, context, recommendation,
      options, priority, status, kind
    )
    SELECT
      ${candidate.hiveId}::uuid,
      ${candidate.goalId}::uuid,
      ${candidate.taskId}::uuid,
      ${title},
      ${context},
      'Rate this completed task from 1-10. Add an optional comment if useful, or dismiss it as no opinion.',
      ${sql.json(options)},
      'normal',
      'pending',
      ${TASK_QUALITY_FEEDBACK_DECISION_KIND}
    WHERE NOT EXISTS (
      SELECT 1
      FROM decisions
      WHERE hive_id = ${candidate.hiveId}::uuid
        AND task_id = ${candidate.taskId}::uuid
        AND kind = ${TASK_QUALITY_FEEDBACK_DECISION_KIND}
        AND status IN ('pending', 'ea_review')
    )
    RETURNING id
  `;

  return rows.length > 0;
}

async function createAiPeerFeedbackDecision(
  sql: Sql,
  candidate: OwnerFeedbackSampleCandidate,
  classificationReason: string,
): Promise<{ decisionCreated: boolean; reviewTaskCreated: boolean }> {
  const title = `AI peer quality review: ${candidate.title}`;
  const completedDate = candidate.completedAt.toISOString();
  const workProductReference = candidate.workProductId
    ? `/tasks?taskId=${candidate.taskId}#work-product-${candidate.workProductId}`
    : null;
  const options = {
    kind: TASK_QUALITY_FEEDBACK_DECISION_KIND,
    lane: "ai_peer" satisfies QualityFeedbackLane,
    provenance: "ai_peer_feedback_sampler",
    classificationReason,
    responseModel: "quality_rating_v1",
    task: {
      id: candidate.taskId,
      title: candidate.title,
      role: candidate.roleSlug,
      completedAt: completedDate,
      workProductId: candidate.workProductId,
      workProductReference,
    },
    fields: [
      { name: "rating", type: "integer", min: 1, max: 10, required: true },
      { name: "comment", type: "text", required: true },
    ],
  };

  const context = buildFeedbackContext(candidate, completedDate, workProductReference);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO decisions (
      hive_id, goal_id, task_id, title, context, recommendation,
      options, priority, status, kind
    )
    SELECT
      ${candidate.hiveId}::uuid,
      ${candidate.goalId}::uuid,
      ${candidate.taskId}::uuid,
      ${title},
      ${context},
      'AI peer review only. Rate this completed task from 1-10 using task brief, work product, and session log evidence.',
      ${sql.json(options)},
      'normal',
      'ea_review',
      ${TASK_QUALITY_FEEDBACK_DECISION_KIND}
    WHERE NOT EXISTS (
      SELECT 1
      FROM decisions
      WHERE hive_id = ${candidate.hiveId}::uuid
        AND task_id = ${candidate.taskId}::uuid
        AND kind = ${TASK_QUALITY_FEEDBACK_DECISION_KIND}
        AND status IN ('pending', 'ea_review')
    )
    RETURNING id
  `;

  if (rows.length === 0) return { decisionCreated: false, reviewTaskCreated: false };
  const reviewTaskCreated = await createQualityReviewerTask(sql, candidate, rows[0].id, classificationReason);
  return { decisionCreated: true, reviewTaskCreated };
}

async function createQualityReviewerTask(
  sql: Sql,
  candidate: OwnerFeedbackSampleCandidate,
  decisionId: string,
  classificationReason: string,
): Promise<boolean> {
  await sql`
    INSERT INTO role_templates (
      slug, name, department, type, adapter_type, recommended_model, skills, terminal
    )
    VALUES (
      'quality-reviewer', 'Quality Reviewer', 'qa', 'executor', 'auto',
      'auto', ${sql.json(["hivewright-ops"])}, true
    )
    ON CONFLICT (slug) DO NOTHING
  `;

  const [existing] = await sql<{ id: string }[]>`
    SELECT id
    FROM tasks
    WHERE parent_task_id = ${candidate.taskId}::uuid
      AND assigned_to = 'quality-reviewer'
      AND status IN ('pending', 'claimed', 'running')
    LIMIT 1
  `;
  if (existing) return false;

  const logs = await sql<{ chunk: string; type: string }[]>`
    SELECT type, chunk
    FROM task_logs
    WHERE task_id = ${candidate.taskId}::uuid
    ORDER BY id DESC
    LIMIT 20
  `;
  const brief = buildQualityReviewerBrief(candidate, decisionId, classificationReason, logs.reverse());
  const rows = await sql<{ id: string }[]>`
    INSERT INTO tasks (
      hive_id, goal_id, assigned_to, created_by, title, brief,
      parent_task_id, priority, qa_required
    )
    VALUES (
      ${candidate.hiveId}::uuid, ${candidate.goalId}::uuid, 'quality-reviewer', 'quality-feedback-sampler',
      ${`AI peer quality review: ${candidate.title}`}, ${brief},
      ${candidate.taskId}::uuid, 4, false
    )
    RETURNING id
  `;
  return rows.length > 0;
}

async function reclassifyPendingQualityFeedback(sql: Sql, hiveId: string): Promise<number> {
  const rows = await sql<(OwnerFeedbackSampleCandidate & { decisionId: string; options: unknown })[]>`
    SELECT
      d.id AS "decisionId",
      d.options,
      t.id AS "taskId",
      t.hive_id AS "hiveId",
      t.goal_id AS "goalId",
      t.title,
      t.brief,
      t.assigned_to AS "roleSlug",
      COALESCE(t.completed_at, t.updated_at, d.created_at) AS "completedAt",
      wp.id AS "workProductId",
      COALESCE(wp.summary, left(wp.content, 240), t.result_summary) AS "workProductSummary"
    FROM decisions d
    JOIN tasks t ON t.id = d.task_id AND t.hive_id = d.hive_id
    LEFT JOIN LATERAL (
      SELECT id, summary, content
      FROM work_products
      WHERE task_id = t.id
        AND hive_id = t.hive_id
      ORDER BY created_at DESC
      LIMIT 1
    ) wp ON true
    WHERE d.hive_id = ${hiveId}::uuid
      AND d.kind = ${TASK_QUALITY_FEEDBACK_DECISION_KIND}
      AND d.status = 'pending'
      AND COALESCE(d.options #>> '{lane}', 'owner') = 'owner'
      AND d.is_qa_fixture = false
  `;

  let reclassified = 0;
  for (const row of rows) {
    const classification = classifyQualityFeedbackLane(row);
    if (classification.lane !== "ai_peer") continue;

    const options = isRecord(row.options)
      ? {
          ...row.options,
          lane: "ai_peer",
          provenance: "ai_peer_feedback_sampler",
          classificationReason: classification.reason,
        }
      : {
          kind: TASK_QUALITY_FEEDBACK_DECISION_KIND,
          lane: "ai_peer",
          provenance: "ai_peer_feedback_sampler",
          classificationReason: classification.reason,
        };
    await sql`
      UPDATE decisions
      SET options = ${sql.json(options)},
          status = 'ea_review'
      WHERE id = ${row.decisionId}::uuid
    `;
    const reviewTaskCreated = await createQualityReviewerTask(
      sql,
      row,
      row.decisionId,
      classification.reason,
    );
    void reviewTaskCreated;
    reclassified++;
  }
  return reclassified;
}

function buildFeedbackContext(
  candidate: OwnerFeedbackSampleCandidate,
  completedDate: string,
  workProductReference: string | null,
): string {
  return [
    `Task: ${candidate.title}`,
    `Role: ${candidate.roleSlug}`,
    `Completed: ${completedDate}`,
    "",
    "Brief/context:",
    truncate(candidate.brief, 900),
    candidate.workProductId ? "" : null,
    candidate.workProductId ? `Work product: ${workProductReference}` : null,
    candidate.workProductSummary ? "" : null,
    candidate.workProductSummary ? `Work product summary: ${truncate(candidate.workProductSummary, 500)}` : null,
  ].filter((line): line is string => line !== null).join("\n");
}

function buildQualityReviewerBrief(
  candidate: OwnerFeedbackSampleCandidate,
  decisionId: string,
  classificationReason: string,
  logs: { chunk: string; type: string }[],
): string {
  return [
    "## AI Peer Quality Review",
    "",
    "Review the completed task using the task brief, work product, and agent session log below.",
    "Emit a 1-10 rating plus a concise evidence-backed comment, then submit it through the existing rating endpoint:",
    `POST /api/decisions/${decisionId}/respond`,
    'Body: {"response":"quality_feedback","rating":<1-10>,"comment":"<evidence-backed review>"}.',
    "",
    `Classification: ${classificationReason}`,
    `Task: ${candidate.title}`,
    `Original role: ${candidate.roleSlug}`,
    "",
    "### Task Brief",
    truncate(candidate.brief, 2_000),
    "",
    "### Work Product",
    truncate(candidate.workProductSummary ?? "(no work product summary found)", 2_000),
    "",
    "### Agent Session Log",
    logs.length > 0
      ? logs.map((log) => `[${log.type}] ${truncate(log.chunk, 500)}`).join("\n")
      : "(no task log rows found)",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}
