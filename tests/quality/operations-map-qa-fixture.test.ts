import { beforeEach, describe, expect, it } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import {
  cleanupOperationsMapParkedQaFixture,
  createOperationsMapParkedQaFixture,
} from "../../src/quality/operations-map-qa-fixture";

describe("operations map parked QA fixture", () => {
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("creates and cleans up a visible hive with a blocked task for manual parked-state QA", async () => {
    const fixture = await createOperationsMapParkedQaFixture(sql);

    expect(fixture.hiveSlug).toBe("operations-map-parked-qa");
    expect(fixture.taskTitle).toBe("Operations Map manual QA parked task");

    const [hive] = await sql<Array<{ name: string; is_system_fixture: boolean }>>`
      SELECT name, is_system_fixture
      FROM hives
      WHERE id = ${fixture.hiveId}::uuid
    `;
    expect(hive).toEqual({
      name: "Operations Map Parked QA",
      is_system_fixture: false,
    });

    const [task] = await sql<Array<{
      title: string;
      status: string;
      created_by: string;
      role_name: string;
      goal_title: string;
    }>>`
      SELECT
        t.title,
        t.status,
        t.created_by,
        rt.name AS role_name,
        g.title AS goal_title
      FROM tasks t
      JOIN role_templates rt ON rt.slug = t.assigned_to
      JOIN goals g ON g.id = t.goal_id AND g.hive_id = t.hive_id
      WHERE t.id = ${fixture.taskId}::uuid
        AND t.hive_id = ${fixture.hiveId}::uuid
    `;
    expect(task).toEqual({
      title: "Operations Map manual QA parked task",
      status: "blocked",
      created_by: "qa-fixture",
      role_name: "Developer Agent",
      goal_title: "Operations Map parked-state fixture",
    });

    await cleanupOperationsMapParkedQaFixture(sql);

    const [remaining] = await sql<Array<{ hives: string; goals: string; tasks: string }>>`
      SELECT
        (SELECT COUNT(*)::text FROM hives WHERE slug = ${fixture.hiveSlug}) AS hives,
        (SELECT COUNT(*)::text FROM goals WHERE id = ${fixture.goalId}::uuid) AS goals,
        (SELECT COUNT(*)::text FROM tasks WHERE id = ${fixture.taskId}::uuid) AS tasks
    `;
    expect(remaining).toEqual({ hives: "0", goals: "0", tasks: "0" });
  });
});
