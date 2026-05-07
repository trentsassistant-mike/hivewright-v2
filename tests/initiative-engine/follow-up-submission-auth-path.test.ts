import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInitiativeEvaluation } from "@/initiative-engine";
import { seedDormantGoalTestFixture } from "./dormant-goal-test-fixture";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const authState = vi.hoisted(() => ({
  authHeader: null as string | null,
  sessionUser: null as { id?: string | null; email?: string | null; name?: string | null } | null,
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(authState.authHeader ? { authorization: authState.authHeader } : {}),
}));

vi.mock("@/auth", () => ({
  auth: async () => (authState.sessionUser ? { user: authState.sessionUser } : null),
}));

let hiveId: string;
let firstGoalId: string;
let secondGoalId: string;
let scheduleId: string;

beforeEach(async () => {
  authState.authHeader = null;
  authState.sessionUser = null;
  process.env.VITEST = "false";
  delete process.env.INTERNAL_SERVICE_TOKEN;

  await truncateAll(sql);
  const fixture = await seedDormantGoalTestFixture(sql, {
    hiveSlugPrefix: "initiative-auth-path-hive",
    hiveName: "Initiative Auth Path Hive",
  });
  hiveId = fixture.hiveId;
  firstGoalId = fixture.primaryGoalId;
  secondGoalId = fixture.secondaryGoalId;
  scheduleId = fixture.scheduleId;
});

afterEach(() => {
  process.env.VITEST = "true";
  delete process.env.INTERNAL_SERVICE_TOKEN;
  vi.unstubAllGlobals();
});

describe.sequential("initiative follow-up submission auth path", () => {
  it("uses the normalized internal bearer to submit work through /api/work and still suppresses the next candidate", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "  initiative-token  ";

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authState.authHeader = headers.get("authorization");
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        hiveId: string;
        input: string;
        goalId?: string | null;
        projectId?: string | null;
        priority: number;
        acceptanceCriteria: string;
      };

      const [task] = await sql<Array<{ id: string; title: string }>>`
        INSERT INTO tasks (
          hive_id,
          goal_id,
          title,
          brief,
          status,
          assigned_to,
          created_by,
          acceptance_criteria,
          priority,
          qa_required,
          project_id
        )
        VALUES (
          ${body.hiveId},
          ${body.goalId ?? null},
          'Initiative auth-path task',
          ${body.input},
          'pending',
          'dev-agent',
          'initiative-engine',
          ${body.acceptanceCriteria},
          ${body.priority},
          false,
          ${body.projectId ?? null}
        )
        RETURNING id, title
      `;

      return new Response(JSON.stringify({
        data: {
          id: task.id,
          type: "task",
          title: task.title,
          classification: {
            provider: "test-provider",
            model: "test-model",
            confidence: 0.9,
            reasoning: "task classification",
            usedFallback: false,
          },
        },
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runInitiativeEvaluation(sql, {
      hiveId,
      trigger: { kind: "schedule", scheduleId },
    });

    expect(result.tasksCreated).toBe(1);
    expect(result.suppressed).toBe(1);
    expect(result.noop).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    expect(init.headers).toMatchObject({
      authorization: "Bearer initiative-token",
      "content-type": "application/json",
    });
    expect(requestBody).not.toHaveProperty("assignedTo");

    const createdOutcome = result.outcomes.find((outcome) => outcome.actionTaken === "create_task");
    const suppressedOutcome = result.outcomes.find((outcome) => outcome.goalId === secondGoalId);

    expect(createdOutcome?.goalId).toBe(firstGoalId);
    expect(suppressedOutcome).toMatchObject({
      actionTaken: "suppress",
      suppressionReason: "per_run_cap",
    });

    const [task] = await sql<Array<{ goal_id: string; created_by: string; assigned_to: string }>>`
      SELECT goal_id, created_by, assigned_to
      FROM tasks
      WHERE id = ${createdOutcome!.createdTaskId!}
    `;
    expect(task).toMatchObject({
      goal_id: firstGoalId,
      created_by: "initiative-engine",
      assigned_to: "dev-agent",
    });

    const [decision] = await sql<Array<{ evidence: { creation?: { classification?: unknown } } }>>`
      SELECT evidence
      FROM initiative_run_decisions
      WHERE run_id = ${result.runId}
        AND candidate_ref = ${firstGoalId}
      LIMIT 1
    `;
    expect(decision.evidence.creation?.classification).toBeDefined();

    const [secondGoalTaskCount] = await sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM tasks
      WHERE hive_id = ${hiveId}
        AND goal_id = ${secondGoalId}
        AND created_by = 'initiative-engine'
    `;
    expect(secondGoalTaskCount.count).toBe(0);
  });
});
