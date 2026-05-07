import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkAndFireSchedules } from "@/dispatcher/schedule-timer";
import { seedDefaultSchedules } from "@/hives/seed-schedules";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const runLlmReleaseScanMock = vi.fn();

vi.mock("@/llm-release-scan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/llm-release-scan")>()),
  runLlmReleaseScan: runLlmReleaseScanMock,
}));

let hiveId: string;
let scheduleId: string;

beforeEach(async () => {
  await truncateAll(sql);
  runLlmReleaseScanMock.mockReset();
  runLlmReleaseScanMock.mockResolvedValue({
    runId: "run-1",
    trigger: { kind: "schedule", scheduleId: "sched-1" },
    discoveries: 0,
    decisionsCreated: 0,
  });

  const [hive] = await sql<Array<{ id: string }>>`
    INSERT INTO hives (slug, name, type)
    VALUES ('release-scan-sched-test', 'Release Scan Schedule Test', 'digital')
    RETURNING id
  `;
  hiveId = hive.id;

  const seedResult = await seedDefaultSchedules(sql, {
    id: hiveId,
    name: "Release Scan Schedule Test",
    description: null,
  });
  expect(seedResult.created).toBe(7);

  const [schedule] = await sql<Array<{ id: string }>>`
    SELECT id
    FROM schedules
    WHERE hive_id = ${hiveId}
      AND task_template ->> 'kind' = 'llm-release-scan'
    LIMIT 1
  `;
  scheduleId = schedule.id;

  await sql`
    UPDATE schedules
    SET next_run_at = CASE
      WHEN id = ${scheduleId} THEN NOW() - interval '1 minute'
      ELSE NOW() + interval '1 day'
    END
    WHERE hive_id = ${hiveId}
  `;
});

describe("checkAndFireSchedules - llm-release-scan", () => {
  it("routes a due weekly release-scan schedule into the runtime and advances the schedule", async () => {
    const fired = await checkAndFireSchedules(sql);
    expect(fired).toBe(1);

    expect(runLlmReleaseScanMock).toHaveBeenCalledTimes(1);
    expect(runLlmReleaseScanMock).toHaveBeenCalledWith(sql, {
      hiveId,
      trigger: {
        kind: "schedule",
        scheduleId,
      },
    });

    const tasks = await sql`
      SELECT id FROM tasks WHERE hive_id = ${hiveId} AND title = 'Weekly LLM release scan'
    `;
    expect(tasks).toHaveLength(0);

    const [after] = await sql<Array<{ last_run_at: Date; next_run_at: Date }>>`
      SELECT last_run_at, next_run_at FROM schedules WHERE id = ${scheduleId}
    `;
    expect(after.last_run_at).not.toBeNull();
    expect(after.next_run_at.getTime()).toBeGreaterThan(Date.now());
  });
});
