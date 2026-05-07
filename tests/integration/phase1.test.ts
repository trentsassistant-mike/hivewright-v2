import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { syncRoleLibrary } from "@/roles/sync";
import { claimNextTask, completeTask } from "@/dispatcher/task-claimer";
import { handleTaskFailure, FailureCategory } from "@/dispatcher/failure-handler";
import { checkSprintCompletion } from "@/dispatcher/sprint-tracker";
import { applyDoctorDiagnosis } from "@/doctor";
import { DEFAULT_CONFIG } from "@/dispatcher/types";
import type { DoctorDiagnosis } from "@/doctor/types";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;
let goalId: string;

beforeEach(async () => {
  await truncateAll(sql);

  // Sync roles (needed for tasks.assigned_to FK)
  await syncRoleLibrary(path.resolve(__dirname, "../../role-library"), sql);

  // Create test hive
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type) VALUES ('integ-test', 'Integration Test', 'digital') RETURNING *
  `;
  bizId = biz.id;

  // Create a goal — session_id set so the live dispatcher ignores it
  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, status, budget_cents, session_id)
    VALUES (${bizId}, 'integ-goal', 'active', 5000, 'gs-integ-fixture')
    RETURNING *
  `;
  goalId = goal.id;
});

describe("Phase 1 Integration", () => {
  it("full lifecycle: create -> claim -> complete", async () => {
    // Insert with retry_after future so the live dispatcher skips it;
    // clear retry_after and claim atomically from the test.
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, retry_after)
      VALUES (${bizId}, 'dev-agent', 'owner', 'integ-lifecycle', 'Build the thing', NOW() + INTERVAL '1 hour')
    `;
    await sql`UPDATE tasks SET retry_after = NULL WHERE title = 'integ-lifecycle' AND status = 'pending'`;

    const task = await claimNextTask(sql, process.pid);
    expect(task).not.toBeNull();
    expect(task!.title).toBe("integ-lifecycle");

    await completeTask(sql, task!.id, "Built the thing successfully");

    const [result] = await sql`SELECT status, result_summary FROM tasks WHERE id = ${task!.id}`;
    expect(result.status).toBe("completed");
    expect(result.result_summary).toBe("Built the thing successfully");
  });

  it("full lifecycle: fail -> retry -> doctor -> escalate", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, retry_count)
      VALUES (${bizId}, 'dev-agent', 'owner', 'integ-fail-chain', 'Impossible task', 'active', 0)
      RETURNING *
    `;

    // Agent-reported failure goes to doctor (spawn failures go to unresolvable instead)
    const result = await handleTaskFailure(sql, task.id, FailureCategory.AgentReported, "Cannot complete this task", DEFAULT_CONFIG);
    expect(result).toBe("doctor");

    // Doctor escalates
    const diagnosis: DoctorDiagnosis = {
      action: "escalate",
      details: "Cannot fix",
      decisionTitle: "integ-decision",
      decisionContext: "Needs owner",
    };
    await applyDoctorDiagnosis(sql, task.id, diagnosis);

    const [final] = await sql`SELECT status FROM tasks WHERE id = ${task.id}`;
    expect(final.status).toBe("unresolvable");

    const decisions = await sql`SELECT * FROM decisions WHERE title = 'integ-decision'`;
    expect(decisions.length).toBe(1);
  });

  it("sprint completion detection works end-to-end", async () => {
    // Create sprint tasks
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id, sprint_number, status)
      VALUES
        (${bizId}, 'dev-agent', 'goal-supervisor', 'integ-sprint-t1', 'B', ${goalId}, 1, 'completed'),
        (${bizId}, 'research-analyst', 'goal-supervisor', 'integ-sprint-t2', 'B', ${goalId}, 1, 'completed')
    `;

    const completed = await checkSprintCompletion(sql);
    expect(completed.some((c) => c.goalId === goalId && c.sprintNumber === 1)).toBe(true);
  });

  it("role library sync populated all system roles", async () => {
    const roles = await sql`SELECT slug, type FROM role_templates WHERE active = true ORDER BY slug`;
    const slugs = roles.map((r) => r.slug);

    expect(slugs).toContain("goal-supervisor");
    expect(slugs).toContain("doctor");
    expect(slugs).toContain("qa");
    expect(slugs).toContain("dev-agent");
    expect(slugs).toContain("bookkeeper");
    expect(slugs).toContain("research-analyst");
    expect(slugs).toContain("content-writer");
  });

  it("doctor can rewrite and retry a failed task", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'dev-agent', 'owner', 'integ-doctor-fix', 'Bad brief', 'failed')
      RETURNING *
    `;

    const diagnosis: DoctorDiagnosis = {
      action: "rewrite_brief",
      details: "Brief was unclear",
      newBrief: "Clear brief: do exactly this specific thing",
    };

    await applyDoctorDiagnosis(sql, task.id, diagnosis);

    const [updated] = await sql`SELECT status, brief, doctor_attempts FROM tasks WHERE id = ${task.id}`;
    expect(updated.status).toBe("pending");
    expect(updated.brief).toBe("Clear brief: do exactly this specific thing");
    expect(updated.doctor_attempts).toBe(1);

    // Now it can be claimed again
    await sql`UPDATE tasks SET status = 'cancelled' WHERE status = 'pending' AND id != ${task.id}`;
    const reclaimed = await claimNextTask(sql, process.pid);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.id).toBe(task.id);
  });
});
