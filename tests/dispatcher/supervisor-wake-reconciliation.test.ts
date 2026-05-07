import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createSupervisorWakeReconciliationState,
  runSupervisorWakeReconciliation,
} from "@/dispatcher/supervisor-wake-reconciliation";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const wakeUpSupervisorMock = vi.fn();
vi.mock("@/goals/supervisor", () => ({
  wakeUpSupervisor: wakeUpSupervisorMock,
}));

let bizId: string;

beforeEach(async () => {
  wakeUpSupervisorMock.mockReset();
  wakeUpSupervisorMock.mockResolvedValue({
    success: true,
    output: "woken",
  });

  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('swrecon-test-biz', 'Supervisor Wake Reconciliation Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('swrecon-test-role', 'Supervisor Wake Reconciliation Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("runSupervisorWakeReconciliation", () => {
  it("wakes a stranded final sprint exactly once for the same process state", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, status, session_id, last_woken_sprint)
      VALUES (${bizId}, 'swrecon-test-goal', 'active', 'gs-swrecon', 1)
      RETURNING *
    `;
    await sql`
      INSERT INTO tasks (
        hive_id, assigned_to, created_by, title, brief, goal_id,
        sprint_number, status, updated_at
      )
      VALUES (
        ${bizId}, 'swrecon-test-role', 'goal-supervisor', 'swrecon-test-final',
        'b', ${goal.id}, 1, 'completed', NOW() - INTERVAL '5 minutes'
      )
    `;

    const state = createSupervisorWakeReconciliationState();
    const first = await runSupervisorWakeReconciliation(sql, state);
    const second = await runSupervisorWakeReconciliation(sql, state);

    expect(first).toMatchObject({
      candidates: 1,
      fired: 1,
      skipped: 0,
      failed: 0,
    });
    expect(second).toMatchObject({
      candidates: 1,
      fired: 0,
      skipped: 1,
      failed: 0,
    });
    expect(wakeUpSupervisorMock).toHaveBeenCalledTimes(1);
    expect(wakeUpSupervisorMock).toHaveBeenCalledWith(sql, goal.id, 1);
  });
});
