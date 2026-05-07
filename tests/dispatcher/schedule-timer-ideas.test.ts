import { describe, it, expect, beforeEach, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const runIdeasDailyReviewMock = vi.fn();

vi.mock("@/ideas/daily-review", () => ({
  runIdeasDailyReview: runIdeasDailyReviewMock,
}));

import { checkAndFireSchedules } from "@/dispatcher/schedule-timer";

let hiveId: string;

beforeEach(async () => {
  await truncateAll(sql);
  runIdeasDailyReviewMock.mockReset();
  runIdeasDailyReviewMock.mockResolvedValue({
    skipped: false,
    openIdeas: 1,
  });

  const [hive] = await sql<{ id: string }[]>`
    INSERT INTO hives (slug, name, type)
    VALUES ('ideas-sched-test', 'Ideas Schedule Test', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;

  await sql`
    INSERT INTO hive_ideas (hive_id, title, created_by, status)
    VALUES (${hiveId}, 'Daily review candidate', 'owner', 'open')
  `;
});

describe("checkAndFireSchedules — ideas-daily-review", () => {
  it("routes due ideas-daily-review schedules into the review runner and advances the schedule", async () => {
    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${hiveId},
        '0 9 * * *',
        ${sql.json({
          kind: "ideas-daily-review",
          assignedTo: "ideas-curator",
          title: "Ideas daily review",
          brief: "(populated at run time)",
        })},
        true,
        NOW() - interval '1 minute',
        'test'
      )
    `;

    const fired = await checkAndFireSchedules(sql);
    expect(fired).toBe(1);

    expect(runIdeasDailyReviewMock).toHaveBeenCalledTimes(1);
    expect(runIdeasDailyReviewMock).toHaveBeenCalledWith(sql, hiveId);

    const placeholderTasks = await sql`
      SELECT id FROM tasks WHERE title = 'Ideas daily review' AND hive_id = ${hiveId}
    `;
    expect(placeholderTasks).toHaveLength(0);

    const [after] = await sql<{ last_run_at: Date; next_run_at: Date }[]>`
      SELECT last_run_at, next_run_at FROM schedules WHERE hive_id = ${hiveId}
    `;
    expect(after.last_run_at).not.toBeNull();
    expect(after.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });
});
