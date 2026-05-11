import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter, CodexEmptyOutputDiagnostic, ProbeResult, SessionContext } from "@/adapters/types";
import { Dispatcher } from "@/dispatcher";
import { decideProviderFailoverRoute } from "@/dispatcher/provider-failover";
import { completeTask } from "@/dispatcher/task-claimer";
import { writeTaskLog } from "@/dispatcher/task-log-writer";
import { readLatestCodexEmptyOutputDiagnostic } from "@/runtime-diagnostics/codex-empty-output";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const diagnostic: CodexEmptyOutputDiagnostic = {
  kind: "codex_empty_output",
  schemaVersion: 1,
  codexEmptyOutput: true,
  exitCode: 1,
  effectiveAdapter: "codex",
  adapterOverride: null,
  modelSlug: "openai-codex/gpt-5.5",
  modelProviderMismatchDetected: false,
  cwd: "/workspace/hivewrightv2",
  taskWorkspace: "/workspace/hivewrightv2",
  rolloutSignaturePresent: true,
  stderrTail: "failed to record rollout items",
  terminalEvents: [],
  truncated: false,
};

function healthyProbe(): Promise<ProbeResult> {
  return Promise.resolve({
    healthy: true,
    status: "healthy",
    reason: {
      code: "healthy",
      message: "Probe succeeded.",
      failureClass: null,
      retryable: false,
    },
    failureClass: null,
    latencyMs: 0,
    costEstimateUsd: 0,
  });
}

vi.mock("@/dispatcher/session-builder", () => ({
  buildSessionContext: vi.fn(async (_sql: unknown, task: { assignedTo: string } & Record<string, unknown>) => ({
    task: task as unknown as SessionContext["task"],
    roleTemplate: { roleMd: null, soulMd: null, toolsMd: null, slug: task.assignedTo, department: null },
    memoryContext: { roleMemory: [], hiveMemory: [], insights: [], capacity: "0/200" },
    skills: [],
    standingInstructions: [],
    goalContext: null,
    projectWorkspace: "/workspace/hivewrightv2",
    model: typeof task.modelOverride === "string" ? task.modelOverride : "openai-codex/gpt-5.5",
    fallbackModel: null,
    primaryAdapterType: typeof task.adapterOverride === "string" ? task.adapterOverride : "codex",
    fallbackAdapterType: null,
    credentials: {},
  } satisfies SessionContext)),
}));

vi.mock("@/dispatcher/worktree-manager", () => ({
  provisionTaskWorkspace: vi.fn(async () => ({
    status: "skipped",
    reason: "test",
    worktreePath: null,
  })),
  inheritTaskWorkspaceFromParent: vi.fn(async () => {}),
}));

vi.mock("@/dispatcher/pre-flight", () => ({
  runPreFlightChecks: vi.fn(async () => ({ passed: true, failures: [] })),
}));

vi.mock("@/dispatcher/provider-failover", () => ({
  decideProviderFailoverRoute: vi.fn((input) => ({
    usedFallback: false,
    adapterType: input.primaryAdapterType,
    model: input.primaryModel,
    canRun: true,
    reason: "primary healthy",
    clearFallbackModel: false,
  })),
}));

function createDispatcherWithAdapter(adapter: Adapter) {
  const dispatcher = new Dispatcher();
  const originalSql = (dispatcher as unknown as { sql: { end: () => Promise<void> } }).sql;
  const internal = dispatcher as unknown as {
    sql: typeof sql;
    resolveAdapter: () => Promise<Adapter>;
    isAdapterHealthy: () => Promise<boolean>;
    executeTask: (task: unknown) => Promise<void>;
  };
  internal.sql = sql;
  internal.resolveAdapter = async () => adapter;
  internal.isAdapterHealthy = async () => true;
  return { dispatcher: internal, close: () => originalSql.end() };
}

async function seedTask(opts: {
  title?: string;
  adapterOverride?: string | null;
  modelOverride?: string | null;
  qaRequired?: boolean;
} = {}) {
  const [hive] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('dispatcher-codex-diagnostics', 'Dispatcher Codex Diagnostics', 'digital')
    RETURNING id
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('dev-agent', 'Dev Agent', 'executor', 'codex')
    ON CONFLICT (slug) DO NOTHING
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('doctor', 'Doctor', 'system', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
  const [task] = await sql`
    INSERT INTO tasks (
      hive_id, assigned_to, created_by, status, title, brief, adapter_override, model_override, qa_required
    )
    VALUES (
      ${hive.id},
      'dev-agent',
      'owner',
      'active',
      ${opts.title ?? 'dispatcher diagnostic fixture'},
      'Brief',
      ${opts.adapterOverride ?? null},
      ${opts.modelOverride ?? null},
      ${opts.qaRequired ?? false}
    )
    RETURNING *
  `;
  return {
    id: task.id,
    hiveId: task.hive_id,
    assignedTo: task.assigned_to,
    createdBy: task.created_by,
    status: task.status,
    priority: task.priority,
    title: task.title,
    brief: task.brief,
    parentTaskId: task.parent_task_id,
    goalId: task.goal_id,
    sprintNumber: task.sprint_number,
    qaRequired: task.qa_required,
    acceptanceCriteria: task.acceptance_criteria,
    retryCount: task.retry_count,
    doctorAttempts: task.doctor_attempts,
    failureReason: task.failure_reason,
    adapterOverride: task.adapter_override,
    modelOverride: task.model_override,
    projectId: task.project_id,
  };
}

async function readClaimedTask(taskId: string) {
  const [task] = await sql`
    SELECT * FROM tasks WHERE id = ${taskId}
  `;
  return {
    id: task.id,
    hiveId: task.hive_id,
    assignedTo: task.assigned_to,
    createdBy: task.created_by,
    status: task.status,
    priority: task.priority,
    title: task.title,
    brief: task.brief,
    parentTaskId: task.parent_task_id,
    goalId: task.goal_id,
    sprintNumber: task.sprint_number,
    qaRequired: task.qa_required,
    acceptanceCriteria: task.acceptance_criteria,
    retryCount: task.retry_count,
    doctorAttempts: task.doctor_attempts,
    failureReason: task.failure_reason,
    adapterOverride: task.adapter_override,
    modelOverride: task.model_override,
    projectId: task.project_id,
  };
}

beforeEach(async () => {
  await truncateAll(sql);
  vi.mocked(decideProviderFailoverRoute).mockImplementation((input) => ({
    usedFallback: false,
    adapterType: input.primaryAdapterType,
    model: input.primaryModel,
    canRun: true,
    reason: "primary healthy",
    clearFallbackModel: false,
  }));
});

describe("dispatcher codex runtime diagnostics", () => {
  it("blocks before adapter execution when runtime health gate says the route cannot run", async () => {
    vi.mocked(decideProviderFailoverRoute).mockReturnValueOnce({
      usedFallback: false,
      adapterType: "codex",
      model: "openai-codex/gpt-5.5",
      canRun: false,
      reason: "primary_unhealthy_no_declared_fallback",
      clearFallbackModel: false,
    });
    const execute = vi.fn(async () => ({
      success: true,
      output: "should not run",
    }));
    const adapter: Adapter = {
      supportsPersistence: false,
      probe: healthyProbe,
      translate: () => "",
      execute,
    };
    const { dispatcher, close } = createDispatcherWithAdapter(adapter);
    await close();
    const task = await seedTask();

    await dispatcher.executeTask(task);

    expect(execute).not.toHaveBeenCalled();
    const [row] = await sql<{ status: string; failure_reason: string | null }[]>`
      SELECT status, failure_reason FROM tasks WHERE id = ${task.id}
    `;
    expect(row.status).toBe("blocked");
    expect(row.failure_reason).toContain("Runtime health gate blocked task before spawn.");
    expect(row.failure_reason).toContain("primary_unhealthy_no_declared_fallback");
  });

  it("resumes the original Codex task session when QA sends work back", async () => {
    const execute = vi.fn(async () => ({
      success: true,
      output: "first deliverable",
      sessionId: "thread-1",
    }));
    const sendMessage = vi.fn(async (sessionId: string, message: string) => {
      void sessionId;
      void message;
      return {
        success: true,
        output: "fixed deliverable",
        sessionId: "thread-1",
      };
    });
    const adapter: Adapter = {
      supportsPersistence: false,
      probe: healthyProbe,
      translate: () => "",
      execute,
      sendMessage,
    };
    const { dispatcher, close } = createDispatcherWithAdapter(adapter);
    await close();
    const task = await seedTask({ title: "Result: dispatcher diagnostic fixture", qaRequired: true });
    await sql`
      UPDATE tasks
      SET brief = 'Build the export and keep existing filters.',
          acceptance_criteria = 'The export must include invoice id and total.'
      WHERE id = ${task.id}
    `;

    await dispatcher.executeTask(task);

    const [capsuleAfterFirstRun] = await sql<{
      session_id: string | null;
      status: string;
      last_output: string;
    }[]>`
      SELECT session_id, status, last_output
      FROM task_execution_capsules
      WHERE task_id = ${task.id}
    `;
    expect(capsuleAfterFirstRun.session_id).toBe("thread-1");
    expect(capsuleAfterFirstRun.status).toBe("active");
    expect(capsuleAfterFirstRun.last_output).toBe("first deliverable");

    await sql`
      UPDATE tasks
      SET status = 'completed'
      WHERE parent_task_id = ${task.id} AND assigned_to = 'qa'
    `;
    await import("@/dispatcher/qa-router").then(({ processQaResult }) =>
      processQaResult(sql, task.id, { passed: false, feedback: "Missing error handling" }),
    );

    const [capsuleAfterQaFail] = await sql<{
      status: string;
      rework_count: number;
      last_qa_feedback: string | null;
    }[]>`
      SELECT status, rework_count, last_qa_feedback
      FROM task_execution_capsules
      WHERE task_id = ${task.id}
    `;
    expect(capsuleAfterQaFail.status).toBe("qa_failed");
    expect(capsuleAfterQaFail.rework_count).toBe(1);
    expect(capsuleAfterQaFail.last_qa_feedback).toBe("Missing error handling");

    await dispatcher.executeTask(await readClaimedTask(task.id));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe("thread-1");
    expect(sendMessage.mock.calls[0][1]).toContain("Missing error handling");
    expect(sendMessage.mock.calls[0][1]).toContain("dispatcher diagnostic fixture");
    expect(sendMessage.mock.calls[0][1]).toContain("Build the export and keep existing filters.");
    expect(sendMessage.mock.calls[0][1]).toContain("The export must include invoice id and total.");

    const [capsuleAfterRework] = await sql<{
      status: string;
      rework_count: number;
      last_output: string;
    }[]>`
      SELECT status, rework_count, last_output
      FROM task_execution_capsules
      WHERE task_id = ${task.id}
    `;
    expect(capsuleAfterRework.status).toBe("active");
    expect(capsuleAfterRework.rework_count).toBe(1);
    expect(capsuleAfterRework.last_output).toBe("fixed deliverable");
  }, 15_000);

  it("persists codex empty-output diagnostic task_logs row before done", async () => {
    const adapter: Adapter = {
      supportsPersistence: false,
      probe: healthyProbe,
      translate: () => "",
      execute: async () => ({
        success: false,
        output: "codex reported error",
        failureReason: "Codex exited code 1: codex reported error",
        runtimeDiagnostics: { codexEmptyOutput: diagnostic },
      }),
    };
    const { dispatcher, close } = createDispatcherWithAdapter(adapter);
    await close();
    const task = await seedTask();

    await dispatcher.executeTask(task);

    const rows = await sql<{ type: string; chunk: string }[]>`
      SELECT type, chunk FROM task_logs WHERE task_id = ${task.id} ORDER BY id ASC
    `;
    const diagnosticIndex = rows.findIndex((row) => row.type === "diagnostic");
    const doneIndex = rows.findIndex((row) => row.type === "done");
    expect(diagnosticIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(diagnosticIndex);
    expect(JSON.parse(rows[diagnosticIndex].chunk)).toMatchObject(diagnostic);
  });

  it("does not overwrite tasks.failure_reason with diagnostic metadata", async () => {
    const adapter: Adapter = {
      supportsPersistence: false,
      probe: healthyProbe,
      translate: () => "",
      execute: async () => ({
        success: false,
        output: "codex reported error",
        failureReason: "Codex exited code 1: codex reported error",
        runtimeDiagnostics: { codexEmptyOutput: diagnostic },
      }),
    };
    const { dispatcher, close } = createDispatcherWithAdapter(adapter);
    await close();
    const task = await seedTask({ title: "Result: dispatcher warning fixture" });

    await dispatcher.executeTask(task);

    const [updated] = await sql<{ failure_reason: string }[]>`
      SELECT failure_reason FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.failure_reason).toBe("Codex exited code 1: codex reported error");
    expect(updated.failure_reason).not.toContain("codex_empty_output");
  });

  it("keeps rollout-truncation runtime warning behavior unchanged", async () => {
    const warning = "Codex rollout registration failed after agent output was captured; HiveWright persisted stdout directly and QA should verify the recorded tail.";
    const task = await seedTask({ title: "Result: dispatcher warning fixture" });

    await writeTaskLog(sql, {
      taskId: task.id,
      chunk: `[runtime-warning] ${warning}`,
      type: "status",
    });
    await completeTask(sql, task.id, "salvaged output", { runtimeWarnings: [warning] });

    const logs = await sql<{ type: string; chunk: string }[]>`
      SELECT type, chunk FROM task_logs WHERE task_id = ${task.id} ORDER BY id ASC
    `;
    expect(logs.some((row) => row.type === "diagnostic")).toBe(false);
    expect(logs.some((row) => row.type === "status" && row.chunk === `[runtime-warning] ${warning}`)).toBe(true);
    const [updated] = await sql<{ status: string; failure_reason: string | null }[]>`
      SELECT status, failure_reason FROM tasks WHERE id = ${task.id}
    `;
    expect(updated.status).toBe("completed");
    expect(updated.failure_reason).toBe(warning);
  });

  it("reconstructs Sprint 4 codex thread-not-found diagnostics from streamed stderr when adapter omitted runtimeDiagnostics", async () => {
    const threadNotFound =
      "codex_core::session: failed to record rollout items: thread 019dd0b1-0f3a-7313-b737-93d8967819fb not found";
    const adapter: Adapter = {
      supportsPersistence: false,
      probe: healthyProbe,
      translate: () => "",
      execute: async (_ctx, onChunk) => {
        await onChunk?.({ text: threadNotFound, type: "stderr" });
        return {
          success: false,
          output: threadNotFound,
          failureReason: `Process exited with code 1: ${threadNotFound}`,
          failureKind: "unknown",
        };
      },
    };
    const { dispatcher, close } = createDispatcherWithAdapter(adapter);
    await close();
    const task = await seedTask({
      adapterOverride: "codex",
      modelOverride: "anthropic/claude-opus-4-7",
    });

    await dispatcher.executeTask(task);

    const rows = await sql<{ type: string; chunk: string }[]>`
      SELECT type, chunk FROM task_logs WHERE task_id = ${task.id} ORDER BY id ASC
    `;
    const diagnosticIndex = rows.findIndex((row) => row.type === "diagnostic");
    const doneIndex = rows.findIndex((row) => row.type === "done");
    expect(diagnosticIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(diagnosticIndex);

    const diagnosticRow = JSON.parse(rows[diagnosticIndex].chunk) as CodexEmptyOutputDiagnostic;
    expect(diagnosticRow).toMatchObject({
      kind: "codex_empty_output",
      codexEmptyOutput: true,
      exitCode: 1,
      effectiveAdapter: "codex",
      adapterOverride: "codex",
      modelSlug: "anthropic/claude-opus-4-7",
      modelProviderMismatchDetected: true,
      rolloutSignaturePresent: true,
    });
    expect(diagnosticRow.stderrTail).toContain("failed to record rollout items");
    expect(Buffer.byteLength(JSON.stringify(diagnosticRow), "utf8")).toBeLessThanOrEqual(8192);

    const normalized = await readLatestCodexEmptyOutputDiagnostic(sql, task.id);
    expect(normalized).toMatchObject({
      codexEmptyOutput: true,
      effectiveAdapter: "codex",
      adapterOverride: "codex",
      modelSlug: "anthropic/claude-opus-4-7",
      modelProviderMismatchDetected: true,
      rolloutSignaturePresent: true,
    });
  });
});
