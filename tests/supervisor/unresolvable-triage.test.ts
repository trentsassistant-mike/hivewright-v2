import { beforeEach, describe, expect, it, vi } from "vitest";
import { testSql as sql } from "../_lib/test-db";
import {
  reconcileUnresolvableTasks,
  type UnresolvableTriageModelHealthChecker,
} from "@/supervisor/unresolvable-triage";

const HIVE_ID = "22222222-2222-4222-8222-222222222222";

async function seedBase() {
  await sql`DELETE FROM decisions WHERE hive_id = ${HIVE_ID}`;
  await sql`DELETE FROM task_workspaces WHERE task_id IN (SELECT id FROM tasks WHERE hive_id = ${HIVE_ID})`;
  await sql`DELETE FROM tasks WHERE hive_id = ${HIVE_ID}`;
  await sql`DELETE FROM goals WHERE hive_id = ${HIVE_ID}`;
  await sql`DELETE FROM schedules WHERE hive_id = ${HIVE_ID}`;
  await sql`DELETE FROM hives WHERE id = ${HIVE_ID}`;
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${HIVE_ID}, 'unresolvable-triage', 'Unresolvable Triage', 'digital')
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type, active)
    VALUES
      ('triage-executor', 'Triage Executor', 'executor', 'codex', true),
      ('doctor', 'Doctor', 'system', 'claude-code', true)
    ON CONFLICT (slug) DO NOTHING
  `;
}

async function insertUnresolvable(input: {
  id: string;
  title: string;
  failureReason: string;
  createdAt?: string;
  adapterOverride?: string | null;
  modelOverride?: string | null;
  parentTaskId?: string | null;
  goalId?: string | null;
}) {
  await sql`
    INSERT INTO tasks (
      id, hive_id, assigned_to, created_by, title, brief, status,
      failure_reason, created_at, updated_at, adapter_override, model_override,
      parent_task_id, goal_id
    )
    VALUES (
      ${input.id}, ${HIVE_ID}, 'triage-executor', 'owner', ${input.title}, 'brief',
      'unresolvable', ${input.failureReason},
      ${input.createdAt ?? "2026-05-01T00:00:00Z"}::timestamptz,
      ${input.createdAt ?? "2026-05-01T00:00:00Z"}::timestamptz,
      ${input.adapterOverride ?? null}, ${input.modelOverride ?? null},
      ${input.parentTaskId ?? null}, ${input.goalId ?? null}
    )
  `;
}

type RouteSelectionEvidence = {
  outcome: string;
  route: { adapterType: string; modelId: string } | null;
  health: {
    canRun: boolean;
    status: string;
    reason: string;
    failureReason?: string | null;
  } | null;
  context: {
    reason: string;
    sourceTaskId: string;
    timestamp: string;
  };
  links: {
    decisionId: string | null;
    spawnedTaskId: string | null;
    supersedingTaskId: string | null;
    fixTaskId: string | null;
  };
  source_confidence: string;
  execution_confidence: string;
  legacy_evidence_confidence: string;
  packaging_schema_version: number;
  provider: string | null;
  runtime: string | null;
  trace_package_ref: {
    status: string;
    reason: string;
  };
  output_package_ref: {
    status: string;
    reason: string;
  };
  evaluation_package_ref: {
    status: string;
    reason: string;
  };
  capture_limitations: string[];
};

async function taskEvidence(taskId: string): Promise<RouteSelectionEvidence> {
  const [task] = await sql<{ route_selection_evidence: RouteSelectionEvidence | null }[]>`
    SELECT route_selection_evidence FROM tasks WHERE id = ${taskId}
  `;
  expect(task?.route_selection_evidence).toBeTruthy();
  return task.route_selection_evidence as RouteSelectionEvidence;
}

function expectCommonEvidence(
  evidence: RouteSelectionEvidence,
  input: {
    outcome: string;
    sourceTaskId: string;
    timestamp?: string;
    reasonIncludes: string;
    route?: { adapterType: string; modelId: string } | null;
  },
) {
  expect(evidence).toMatchObject({
    outcome: input.outcome,
    route: input.route ?? null,
    context: {
      sourceTaskId: input.sourceTaskId,
      timestamp: input.timestamp ?? "2026-05-05T00:00:00.000Z",
    },
  });
  expect(evidence.context.reason).toContain(input.reasonIncludes);
}

function expectPolicyEvidence(
  evidence: RouteSelectionEvidence,
  input: {
    provider: string | null;
    runtime: string | null;
    executionConfidence?: string;
  },
) {
  const executionConfidence = input.executionConfidence ?? "low";
  expect(evidence).toMatchObject({
    source_confidence: "medium",
    execution_confidence: executionConfidence,
    legacy_evidence_confidence: executionConfidence,
    packaging_schema_version: 1,
    provider: input.provider,
    runtime: input.runtime,
    trace_package_ref: {
      status: "not_available",
    },
    output_package_ref: {
      status: "not_available",
    },
    evaluation_package_ref: {
      status: "not_available",
    },
  });
  expect(evidence.trace_package_ref.reason).toContain("trace");
  expect(evidence.output_package_ref.reason).toContain("output");
  expect(evidence.evaluation_package_ref.reason).toContain("evaluation");
  expect(evidence.capture_limitations).toEqual(
    expect.arrayContaining([
      expect.stringContaining("No retained trace package"),
      expect.stringContaining("No retained output package"),
      expect.stringContaining("No retained evaluation package"),
    ]),
  );
}

beforeEach(seedBase);

describe("reconcileUnresolvableTasks", () => {
  it("preserves provider-neutral evidence confidence and packaging metadata on task routing evidence", async () => {
    const taskId = "12121212-1212-4212-8212-121212121212";
    await insertUnresolvable({
      id: taskId,
      title: "Reconnect integration",
      failureReason: "Connector permission denied for OAuth scope.",
      adapterOverride: "claude-code",
      modelOverride: "claude-sonnet-4.5",
    });

    const result = await reconcileUnresolvableTasks(sql, HIVE_ID, {
      now: new Date("2026-05-05T00:00:00Z"),
    });

    expect(result.byOutcome.needs_ea_review).toBe(1);
    const [decision] = await sql<{ route_metadata: RouteSelectionEvidence | null }[]>`
      SELECT route_metadata FROM decisions WHERE task_id = ${taskId}
    `;
    const evidence = await taskEvidence(taskId);
    expectPolicyEvidence(evidence, {
      provider: "anthropic",
      runtime: "claude-code",
    });
    expect(decision.route_metadata).toEqual(evidence);
  });

  it("stores decision-linked evidence for genuinely owner-blocked tasks routed through EA review", async () => {
    const taskId = "33333333-3333-4333-8333-333333333333";
    await insertUnresolvable({
      id: taskId,
      title: "Choose production vendor",
      failureReason: "Owner input required: choose between vendors.",
      adapterOverride: "codex",
      modelOverride: "gpt-5.5",
    });

    const result = await reconcileUnresolvableTasks(sql, HIVE_ID, {
      now: new Date("2026-05-05T00:00:00Z"),
    });

    expect(result.byOutcome.genuinely_owner_blocked).toBe(1);
    const [decision] = await sql<{
      id: string;
      status: string;
      kind: string;
      task_id: string;
      route_metadata: RouteSelectionEvidence | null;
    }[]>`
      SELECT id, status, kind, task_id, route_metadata FROM decisions WHERE task_id = ${taskId}
    `;
    expect(decision).toMatchObject({
      status: "ea_review",
      kind: "unresolvable_task_triage",
      task_id: taskId,
    });
    const evidence = await taskEvidence(taskId);
    expectCommonEvidence(evidence, {
      outcome: "genuinely_owner_blocked",
      sourceTaskId: taskId,
      reasonIncludes: "Owner input required",
      route: { adapterType: "codex", modelId: "gpt-5.5" },
    });
    expect(evidence.links.decisionId).toBe(decision.id);
    expect(evidence.links.spawnedTaskId).toBeNull();
    expect(decision.route_metadata).toEqual(evidence);
  });

  it("stores health-backed evidence when retrying runtime failures after model health recovers", async () => {
    const taskId = "44444444-4444-4444-8444-444444444444";
    await insertUnresolvable({
      id: taskId,
      title: "Retry once route recovers",
      failureReason: "Codex exited code 1: route unavailable",
      adapterOverride: "codex",
      modelOverride: "gpt-5.5",
    });
    const checker = vi.fn<UnresolvableTriageModelHealthChecker>()
      .mockResolvedValueOnce({
        canRun: false,
        reason: "health_probe_unhealthy",
        status: "unhealthy",
        failureReason: "probe failed",
      })
      .mockResolvedValueOnce({
        canRun: true,
        reason: "fresh_healthy_probe",
        status: "healthy",
      });

    const blocked = await reconcileUnresolvableTasks(sql, HIVE_ID, {
      checkModelHealth: checker,
      now: new Date("2026-05-05T00:00:00Z"),
    });
    expect(blocked.byOutcome.retryable).toBe(0);
    expect(blocked.byOutcome.needs_doctor).toBe(1);

    await sql`DELETE FROM tasks WHERE assigned_to = 'doctor' AND parent_task_id = ${taskId}`;
    const retried = await reconcileUnresolvableTasks(sql, HIVE_ID, {
      checkModelHealth: checker,
      now: new Date("2026-05-05T00:01:00Z"),
    });

    expect(retried.byOutcome.retryable).toBe(1);
    const [task] = await sql<{
      status: string;
      retry_count: number;
      retry_after: Date | null;
      failure_reason: string | null;
    }[]>`
      SELECT status, retry_count, retry_after, failure_reason
      FROM tasks
      WHERE id = ${taskId}
    `;
    expect(task.status).toBe("pending");
    expect(task.retry_count).toBe(0);
    expect(task.retry_after).toBeNull();
    expect(task.failure_reason).toContain("retried after model health recovered");
    const evidence = await taskEvidence(taskId);
    expectCommonEvidence(evidence, {
      outcome: "retryable",
      sourceTaskId: taskId,
      timestamp: "2026-05-05T00:01:00.000Z",
      reasonIncludes: "Codex exited code 1",
      route: { adapterType: "codex", modelId: "gpt-5.5" },
    });
    expect(evidence.health).toMatchObject({
      canRun: true,
      status: "healthy",
      reason: "fresh_healthy_probe",
    });
    expectPolicyEvidence(evidence, {
      provider: "openai",
      runtime: "codex",
      executionConfidence: "medium",
    });
    expect(evidence.links).toEqual({
      decisionId: null,
      spawnedTaskId: null,
      supersedingTaskId: null,
      fixTaskId: null,
    });
    const [event] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata
      FROM agent_audit_events
      WHERE task_id = ${taskId}
        AND event_type = 'task.lifecycle_transition'
    `;
    expect(event.metadata).toMatchObject({
      taskId,
      hiveId: HIVE_ID,
      previousStatus: "unresolvable",
      nextStatus: "pending",
      source: "supervisor.unresolvableTriage.retryTask",
    });
  });

  it("stores spawned doctor task evidence when runtime health remains blocked", async () => {
    const taskId = "11111111-1111-4111-8111-111111111111";
    await insertUnresolvable({
      id: taskId,
      title: "Diagnose blocked route",
      failureReason: "Codex exited code 1: model health probe failed",
      adapterOverride: "codex",
      modelOverride: "gpt-5.5",
    });
    const checker = vi.fn<UnresolvableTriageModelHealthChecker>().mockResolvedValueOnce({
      canRun: false,
      reason: "health_probe_unhealthy",
      status: "unhealthy",
      failureReason: "probe failed",
    });

    const result = await reconcileUnresolvableTasks(sql, HIVE_ID, {
      checkModelHealth: checker,
      now: new Date("2026-05-05T00:00:00Z"),
    });

    expect(result.byOutcome.needs_doctor).toBe(1);
    const [doctorTask] = await sql<{ id: string }[]>`
      SELECT id FROM tasks WHERE assigned_to = 'doctor' AND parent_task_id = ${taskId}
    `;
    const evidence = await taskEvidence(taskId);
    expectCommonEvidence(evidence, {
      outcome: "needs_doctor",
      sourceTaskId: taskId,
      reasonIncludes: "Codex exited code 1",
      route: { adapterType: "codex", modelId: "gpt-5.5" },
    });
    expect(evidence.health).toMatchObject({
      canRun: false,
      status: "unhealthy",
      reason: "health_probe_unhealthy",
      failureReason: "probe failed",
    });
    expect(evidence.links.spawnedTaskId).toBe(doctorTask.id);
  });

  it("stores decision-linked evidence for EA-review triage", async () => {
    const taskId = "77777777-7777-4777-8777-777777777777";
    await insertUnresolvable({
      id: taskId,
      title: "Reconnect integration",
      failureReason: "Connector permission denied for OAuth scope.",
      adapterOverride: "claude-code",
      modelOverride: "claude-sonnet-4.5",
    });

    const result = await reconcileUnresolvableTasks(sql, HIVE_ID, {
      now: new Date("2026-05-05T00:00:00Z"),
    });

    expect(result.byOutcome.needs_ea_review).toBe(1);
    const [decision] = await sql<{ id: string; route_metadata: RouteSelectionEvidence | null }[]>`
      SELECT id, route_metadata FROM decisions WHERE task_id = ${taskId}
    `;
    const evidence = await taskEvidence(taskId);
    expectCommonEvidence(evidence, {
      outcome: "needs_ea_review",
      sourceTaskId: taskId,
      reasonIncludes: "Connector permission denied",
      route: { adapterType: "claude-code", modelId: "claude-sonnet-4.5" },
    });
    expect(evidence.links.decisionId).toBe(decision.id);
    expect(decision.route_metadata).toEqual(evidence);
  });

  it("stores superseding task evidence when archiving duplicate historical rows", async () => {
    const parentId = "55555555-5555-4555-8555-555555555555";
    const taskId = "66666666-6666-4666-8666-666666666666";
    const replacementId = "88888888-8888-4888-8888-888888888888";
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, title, brief, status, created_at, updated_at)
      VALUES (${parentId}, ${HIVE_ID}, 'triage-executor', 'owner', 'Parent', 'brief', 'completed',
        '2026-04-30T00:00:00Z'::timestamptz, '2026-05-02T00:00:00Z'::timestamptz)
    `;
    await insertUnresolvable({
      id: taskId,
      title: "Historical failed attempt",
      failureReason: "Recovery budget exhausted.",
      parentTaskId: parentId,
      createdAt: "2026-05-01T00:00:00Z",
    });
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, title, brief, status, parent_task_id, created_at, updated_at)
      VALUES (${replacementId}, ${HIVE_ID}, 'triage-executor', 'doctor', 'Replacement', 'brief', 'pending', ${parentId},
        '2026-05-02T00:00:00Z'::timestamptz, '2026-05-02T01:00:00Z'::timestamptz)
    `;

    const result = await reconcileUnresolvableTasks(sql, HIVE_ID, {
      now: new Date("2026-05-05T00:00:00Z"),
    });

    expect(result.byOutcome.duplicate_historical).toBe(1);
    const [task] = await sql<{ status: string; result_summary: string | null }[]>`
      SELECT status, result_summary FROM tasks WHERE id = ${taskId}
    `;
    expect(task.status).toBe("superseded");
    expect(task.result_summary).toContain("duplicate historical recovery noise");
    const evidence = await taskEvidence(taskId);
    expectCommonEvidence(evidence, {
      outcome: "duplicate_historical",
      sourceTaskId: taskId,
      reasonIncludes: "Recovery budget exhausted",
    });
    expect(evidence.links.supersedingTaskId).toBe(replacementId);
    const [event] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata
      FROM agent_audit_events
      WHERE task_id = ${taskId}
        AND event_type = 'task.lifecycle_transition'
    `;
    expect(event.metadata).toMatchObject({
      taskId,
      hiveId: HIVE_ID,
      previousStatus: "unresolvable",
      nextStatus: "superseded",
      source: "supervisor.unresolvableTriage.duplicateHistorical",
    });
  });

  it("stores fix task evidence when later completed work resolves the source", async () => {
    const parentId = "55555555-5555-4555-8555-555555555555";
    const taskId = "99999999-9999-4999-8999-999999999999";
    const fixTaskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, title, brief, status, created_at, updated_at)
      VALUES (${parentId}, ${HIVE_ID}, 'triage-executor', 'owner', 'Parent', 'brief', 'completed',
        '2026-04-30T00:00:00Z'::timestamptz, '2026-05-02T00:00:00Z'::timestamptz)
    `;
    await insertUnresolvable({
      id: taskId,
      title: "Historical failed attempt",
      failureReason: "Recovery budget exhausted.",
      parentTaskId: parentId,
      createdAt: "2026-05-01T00:00:00Z",
    });
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, title, brief, status, parent_task_id, created_at, updated_at)
      VALUES (${fixTaskId}, ${HIVE_ID}, 'triage-executor', 'doctor', 'Replacement', 'brief', 'completed', ${parentId},
        '2026-05-02T00:00:00Z'::timestamptz, '2026-05-02T01:00:00Z'::timestamptz)
    `;

    const result = await reconcileUnresolvableTasks(sql, HIVE_ID, {
      now: new Date("2026-05-05T00:00:00Z"),
    });

    expect(result.byOutcome.fixed_by_later_work).toBe(1);
    const [task] = await sql<{ status: string; result_summary: string | null; failure_reason: string | null }[]>`
      SELECT status, result_summary, failure_reason FROM tasks WHERE id = ${taskId}
    `;
    expect(task.status).toBe("completed");
    expect(task.failure_reason).toBeNull();
    expect(task.result_summary).toContain("fixed by later completed work");
    const evidence = await taskEvidence(taskId);
    expectCommonEvidence(evidence, {
      outcome: "fixed_by_later_work",
      sourceTaskId: taskId,
      reasonIncludes: "Recovery budget exhausted",
    });
    expect(evidence.links.fixTaskId).toBe(fixTaskId);
    const [event] = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata
      FROM agent_audit_events
      WHERE task_id = ${taskId}
        AND event_type = 'task.lifecycle_transition'
    `;
    expect(event.metadata).toMatchObject({
      taskId,
      hiveId: HIVE_ID,
      previousStatus: "unresolvable",
      nextStatus: "completed",
      source: "supervisor.unresolvableTriage.fixedByLaterWork",
    });
  });
});
