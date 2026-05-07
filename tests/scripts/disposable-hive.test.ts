import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { withDisposableHive } from "../../scripts/_lib/disposable-hive";

describe("withDisposableHive", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("hard-deletes the hive and its dependent rows when the callback fails", async () => {
    let capturedHiveId: string | null = null;

    await expect(
      withDisposableHive(sql, "Deliberate Cleanup Failure", async (hiveId) => {
        capturedHiveId = hiveId;

        const [goal] = await sql<Array<{ id: string }>>`
          INSERT INTO goals (hive_id, title, description, status)
          VALUES (${hiveId}, 'Disposable goal', 'Should be deleted in finally.', 'active')
          RETURNING id
        `;

        const [task] = await sql<Array<{ id: string }>>`
          INSERT INTO tasks (
            hive_id,
            assigned_to,
            created_by,
            status,
            priority,
            title,
            brief,
            goal_id,
            acceptance_criteria
          )
          VALUES (
            ${hiveId},
            'dev-agent',
            'test',
            'pending',
            3,
            'Disposable task',
            'This row should be removed.',
            ${goal.id},
            'Cleanup removes this task.'
          )
          RETURNING id
        `;

        const [decision] = await sql<Array<{ id: string }>>`
          INSERT INTO decisions (hive_id, goal_id, task_id, title, context, recommendation)
          VALUES (
            ${hiveId},
            ${goal.id},
            ${task.id},
            'Disposable decision',
            'This row should be removed.',
            'Delete everything'
          )
          RETURNING id
        `;

        await sql`
          INSERT INTO decision_messages (decision_id, sender, content)
          VALUES (${decision.id}, 'system', 'Disposable message')
        `;

        await sql`
          INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
          VALUES (
            ${hiveId},
            '0 * * * *',
            ${sql.json({
              kind: "initiative-evaluation",
              assignedTo: "initiative-engine",
              title: "Initiative evaluation",
              brief: "(populated at run time)",
            })},
            true,
            NOW() - interval '1 minute',
            'test'
          )
        `;

        await sql`
          INSERT INTO work_products (task_id, hive_id, role_slug, content)
          VALUES (${task.id}, ${hiveId}, 'dev-agent', 'Disposable work product')
        `;

        throw new Error("deliberate failure");
      }),
    ).rejects.toThrow("deliberate failure");

    if (capturedHiveId === null) {
      throw new Error("expected disposable hive id to be captured");
    }

    const hiveId = capturedHiveId;

    const [remaining] = await sql<Array<{
      hives: number;
      goals: number;
      tasks: number;
      decisions: number;
      messages: number;
      schedules: number;
      workProducts: number;
    }>>`
      SELECT
        (SELECT COUNT(*)::int FROM hives WHERE id = ${hiveId}) AS hives,
        (SELECT COUNT(*)::int FROM goals WHERE hive_id = ${hiveId}) AS goals,
        (SELECT COUNT(*)::int FROM tasks WHERE hive_id = ${hiveId}) AS tasks,
        (SELECT COUNT(*)::int FROM decisions WHERE hive_id = ${hiveId}) AS decisions,
        (
          SELECT COUNT(*)::int
          FROM decision_messages
          WHERE decision_id IN (
            SELECT id FROM decisions WHERE hive_id = ${hiveId}
          )
        ) AS messages,
        (SELECT COUNT(*)::int FROM schedules WHERE hive_id = ${hiveId}) AS schedules,
        (SELECT COUNT(*)::int FROM work_products WHERE hive_id = ${hiveId}) AS "workProducts"
    `;

    expect(remaining).toEqual({
      hives: 0,
      goals: 0,
      tasks: 0,
      decisions: 0,
      messages: 0,
      schedules: 0,
      workProducts: 0,
    });
  });
});
