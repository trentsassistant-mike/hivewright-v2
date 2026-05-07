import type { Sql } from "postgres";
import { randomUUID } from "node:crypto";
import { TASK_QUALITY_FEEDBACK_DECISION_KIND } from "./owner-feedback-sampler";

export interface QualityFeedbackQaFixture {
  runId: string;
  hiveId: string;
  taskId: string;
  decisionId: string;
}

export interface CreateQualityFeedbackQaFixtureOptions {
  runId?: string;
  hiveId?: string;
  taskTitle?: string;
}

export async function createQualityFeedbackQaFixture(
  sql: Sql,
  options: CreateQualityFeedbackQaFixtureOptions = {},
): Promise<QualityFeedbackQaFixture> {
  const runId = options.runId ?? `qa-${randomUUID()}`;
  const hiveId = options.hiveId ?? randomUUID();
  const taskId = randomUUID();
  const title = options.taskTitle ?? "QA smoke quality feedback fixture";

  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (
      ${hiveId}::uuid,
      ${`qa-fixture-${runId}`.slice(0, 63)},
      'QA Fixture Hive',
      'digital'
    )
    ON CONFLICT (id) DO NOTHING
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
      ${taskId}::uuid,
      ${hiveId}::uuid,
      'dev-agent',
      'qa-fixture',
      'completed',
      5,
      ${title},
      ${`QA smoke fixture for quality feedback run ${runId}.`},
      NOW()
    )
  `;

  const [decision] = await sql<{ id: string }[]>`
    INSERT INTO decisions (
      hive_id, task_id, title, context, recommendation,
      options, priority, status, kind, is_qa_fixture
    )
    VALUES (
      ${hiveId}::uuid,
      ${taskId}::uuid,
      ${`Task quality check: ${title}`},
      ${`QA smoke fixture run ${runId}. This row must not be visible in owner-facing default views.`},
      'Rate this completed task from 1-10. Add an optional comment if useful, or dismiss it as no opinion.',
      ${sql.json({
        kind: TASK_QUALITY_FEEDBACK_DECISION_KIND,
        responseModel: "quality_rating_v1",
        qa: { fixture: true, runId },
        task: {
          id: taskId,
          title,
          role: "dev-agent",
          completedAt: new Date().toISOString(),
          workProductId: null,
          workProductReference: null,
        },
        fields: [
          { name: "rating", type: "integer", min: 1, max: 10, required: true },
          { name: "comment", type: "text", required: false },
        ],
        options: [
          { label: "No opinion / dismiss", action: "dismiss_quality_feedback" },
        ],
      })},
      'normal',
      'pending',
      ${TASK_QUALITY_FEEDBACK_DECISION_KIND},
      true
    )
    RETURNING id
  `;

  return { runId, hiveId, taskId, decisionId: decision.id };
}

export async function cleanupQualityFeedbackQaFixtures(
  sql: Sql,
  runId: string,
): Promise<void> {
  const rows = await sql<{ task_id: string; hive_id: string }[]>`
    SELECT task_id, hive_id
    FROM decisions
    WHERE is_qa_fixture = true
      AND options #>> '{qa,runId}' = ${runId}
  `;

  await sql`
    DELETE FROM task_quality_signals
    WHERE is_qa_fixture = true
      AND evidence LIKE ${`%Decision%`}
      AND task_id IN (
        SELECT task_id
        FROM decisions
        WHERE is_qa_fixture = true
          AND options #>> '{qa,runId}' = ${runId}
      )
  `;

  await sql`
    DELETE FROM decisions
    WHERE is_qa_fixture = true
      AND options #>> '{qa,runId}' = ${runId}
  `;

  for (const row of rows) {
    if (!row.task_id) continue;
    await sql`
      DELETE FROM tasks
      WHERE id = ${row.task_id}::uuid
        AND hive_id = ${row.hive_id}::uuid
        AND created_by = 'qa-fixture'
    `;
  }
}

export async function withQualityFeedbackQaFixture<T>(
  sql: Sql,
  run: (fixture: QualityFeedbackQaFixture) => Promise<T>,
  options: CreateQualityFeedbackQaFixtureOptions = {},
): Promise<T> {
  const fixture = await createQualityFeedbackQaFixture(sql, options);
  try {
    return await run(fixture);
  } finally {
    await cleanupQualityFeedbackQaFixtures(sql, fixture.runId);
  }
}
