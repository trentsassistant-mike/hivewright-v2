import { describe, it, expect, beforeEach, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { applyDoctorDiagnosis } from "@/doctor";
import { applyReclassify, applyConvertToGoal } from "@/doctor/reclassify";
import type { ClassifierOutcome } from "@/work-intake/types";

let stubOutcome: ClassifierOutcome = {
  result: null, attempts: [], usedFallback: false, providerUsed: "default-goal-fallback", modelUsed: null,
};
vi.mock("@/work-intake/runner", () => ({
  runClassifier: vi.fn(async () => stubOutcome),
}));

let bizId: string;

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO role_templates (slug, name, department, type, adapter_type, active)
    VALUES
      ('dev-agent', 'Dev', 'engineering', 'executor', 'claude-code', true),
      ('data-analyst', 'Data', 'research', 'executor', 'claude-code', true),
      ('system-health-auditor', 'Auditor', 'operations', 'executor', 'claude-code', true)
    ON CONFLICT (slug) DO NOTHING
  `;
  const [biz] = await sql`
    INSERT INTO hives (slug, name, type) VALUES ('rec-biz', 'Rec', 'digital') RETURNING id
  `;
  bizId = biz.id;
});

describe("applyReclassify", () => {
  it("updates assigned_to and supersedes the old classification when classifier picks a new role", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'dev-agent', 'owner', 'Audit question', 'Why did dispatcher restart?', 'failed')
      RETURNING *
    `;
    const [oldCls] = await sql`
      INSERT INTO classifications (task_id, type, assigned_role, confidence, reasoning, provider, model, was_fallback)
      VALUES (${task.id}, 'task', 'dev-agent', 0.70, 'initial guess', 'ollama', 'qwen3:32b', false)
      RETURNING *
    `;

    stubOutcome = {
      result: { type: "task", role: "system-health-auditor", confidence: 0.95, reasoning: "diagnostic query" },
      attempts: [{ provider: "ollama", model: "qwen3:32b", prompt: "p", input: task.brief as string,
        responseRaw: "", tokensIn: 50, tokensOut: 10, costCents: 0, latencyMs: 200, success: true, errorReason: null }],
      usedFallback: false, providerUsed: "ollama", modelUsed: "qwen3:32b",
    };

    await applyReclassify(sql, task.id, "executor said this isn't my job");

    const [updated] = await sql`SELECT assigned_to, status, doctor_attempts, retry_count FROM tasks WHERE id = ${task.id}`;
    expect(updated.assigned_to).toBe("system-health-auditor");
    expect(updated.status).toBe("pending");
    expect(updated.doctor_attempts).toBe(1);
    expect(updated.retry_count).toBe(0);

    const [oldRefreshed] = await sql`SELECT superseded_by FROM classifications WHERE id = ${oldCls.id}`;
    expect(oldRefreshed.superseded_by).not.toBeNull();
  });

  it("converts to goal when classifier returns null", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'dev-agent', 'owner', 'Ambiguous', 'do a thing', 'failed')
      RETURNING *
    `;
    await sql`
      INSERT INTO classifications (task_id, type, assigned_role, confidence, reasoning, provider, model, was_fallback)
      VALUES (${task.id}, 'task', 'dev-agent', 0.65, 'guess', 'ollama', 'qwen3:32b', false)
    `;

    stubOutcome = {
      result: null, attempts: [], usedFallback: false, providerUsed: "default-goal-fallback", modelUsed: null,
    };

    await applyReclassify(sql, task.id, "can't figure out role");

    const [taskRow] = await sql`SELECT status, result_summary FROM tasks WHERE id = ${task.id}`;
    expect(taskRow.status).toBe("cancelled");
    expect(taskRow.result_summary).toMatch(/converted to goal/i);

    const [newGoal] = await sql`SELECT title, description FROM goals WHERE hive_id = ${bizId}`;
    expect(newGoal.title).toBe("Ambiguous");
    expect(newGoal.description).toContain("do a thing");
  });

  it("converts to goal when classifier picks the same role as before", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'dev-agent', 'owner', 'T', 'brief', 'failed')
      RETURNING *
    `;
    await sql`
      INSERT INTO classifications (task_id, type, assigned_role, confidence, reasoning, provider, model, was_fallback)
      VALUES (${task.id}, 'task', 'dev-agent', 0.80, 'first guess', 'ollama', 'qwen3:32b', false)
    `;

    stubOutcome = {
      result: { type: "task", role: "dev-agent", confidence: 0.85, reasoning: "same guess" },
      attempts: [{ provider: "ollama", model: "qwen3:32b", prompt: "p", input: "brief",
        responseRaw: "", tokensIn: 1, tokensOut: 1, costCents: 0, latencyMs: 10, success: true, errorReason: null }],
      usedFallback: false, providerUsed: "ollama", modelUsed: "qwen3:32b",
    };

    await applyReclassify(sql, task.id, "failed again");

    const [taskRow] = await sql`SELECT status FROM tasks WHERE id = ${task.id}`;
    expect(taskRow.status).toBe("cancelled");
    const goals = await sql`SELECT id FROM goals WHERE hive_id = ${bizId}`;
    expect(goals).toHaveLength(1);
  });
});

describe("applyConvertToGoal", () => {
  it("creates a goal, re-links attachments, and cancels the task", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'dev-agent', 'owner', 'T2', 'brief2', 'failed')
      RETURNING *
    `;
    await sql`
      INSERT INTO task_attachments (task_id, filename, storage_path, mime_type, size_bytes)
      VALUES (${task.id}, 'a.png', '/tmp/a.png', 'image/png', 1234)
    `;

    await applyConvertToGoal(sql, task.id);

    const [goal] = await sql`SELECT id FROM goals WHERE hive_id = ${bizId}`;
    expect(goal).toBeDefined();

    const [attachment] = await sql`SELECT task_id, goal_id FROM task_attachments LIMIT 1`;
    expect(attachment.task_id).toBeNull();
    expect(attachment.goal_id).toBe(goal.id);

    const [updated] = await sql`SELECT status, result_summary FROM tasks WHERE id = ${task.id}`;
    expect(updated.status).toBe("cancelled");
    expect(updated.result_summary).toContain(goal.id);
  });
});

describe("applyDoctorDiagnosis with new actions", () => {
  it("dispatches to applyReclassify", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'dev-agent', 'owner', 'T', 'b', 'failed') RETURNING *
    `;
    await sql`
      INSERT INTO classifications (task_id, type, assigned_role, confidence, reasoning, provider, model, was_fallback)
      VALUES (${task.id}, 'task', 'dev-agent', 0.7, 'first', 'ollama', 'qwen3:32b', false)
    `;
    stubOutcome = {
      result: { type: "task", role: "data-analyst", confidence: 0.9, reasoning: "new" },
      attempts: [{ provider: "ollama", model: "qwen3:32b", prompt: "p", input: "b",
        responseRaw: "", tokensIn: 1, tokensOut: 1, costCents: 0, latencyMs: 10, success: true, errorReason: null }],
      usedFallback: false, providerUsed: "ollama", modelUsed: "qwen3:32b",
    };

    await applyDoctorDiagnosis(sql, task.id, {
      action: "reclassify",
      details: "Role seems wrong",
      failureContext: "executor said not my job",
    });

    const [updated] = await sql`SELECT assigned_to FROM tasks WHERE id = ${task.id}`;
    expect(updated.assigned_to).toBe("data-analyst");
  });

  it("dispatches to applyConvertToGoal", async () => {
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'dev-agent', 'owner', 'T3', 'b3', 'failed') RETURNING *
    `;
    await applyDoctorDiagnosis(sql, task.id, {
      action: "convert-to-goal",
      details: "too big for one task",
    });
    const [updated] = await sql`SELECT status FROM tasks WHERE id = ${task.id}`;
    expect(updated.status).toBe("cancelled");
    const goals = await sql`SELECT id FROM goals WHERE hive_id = ${bizId}`;
    expect(goals).toHaveLength(1);
  });
});
