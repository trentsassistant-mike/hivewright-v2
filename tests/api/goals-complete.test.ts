import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import * as gate from "@/software-pipeline/landed-state-gate";
import { POST } from "@/app/api/goals/[id]/complete/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const authState = vi.hoisted(() => ({
  authHeader: null as string | null,
  sessionUser: null as { email: string } | null,
}));

vi.mock("next/headers", () => ({
  headers: async () => {
    const headers = new Headers();
    if (authState.authHeader) headers.set("authorization", authState.authHeader);
    return headers;
  },
}));

vi.mock("@/auth", () => ({
  auth: async () => (authState.sessionUser ? { user: authState.sessionUser } : null),
}));

vi.mock("@/software-pipeline/landed-state-gate", () => ({
  verifyLandedState: vi.fn(),
}));

const INTERNAL_TOKEN = "goals-complete-internal-token";
const OWNER_USER_ID = "11111111-2222-4333-8444-555555555555";
const MEMBER_USER_ID = "22222222-3333-4444-8555-666666666666";
let bizId: string;
let goalId: string;
let tmp: string;

beforeEach(async () => {
  process.env.VITEST = "true";
  delete process.env.INTERNAL_SERVICE_TOKEN;
  authState.authHeader = null;
  authState.sessionUser = null;
  vi.clearAllMocks();

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goals-complete-"));
  const cfgPath = path.join(tmp, "openclaw.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ agents: { list: [] } }));
  process.env.OPENCLAW_CONFIG_PATH = cfgPath;
  vi.mocked(gate.verifyLandedState).mockResolvedValue({ ok: true, failures: [] });

  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES ('gccomplete-biz', 'GC Complete Test', 'digital')
    RETURNING *
  `;
  bizId = biz.id;

  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES ('gccomplete-role', 'GCC Role', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;

  // session_id set + status='active' so the live dispatcher's findNewGoals
  // (WHERE session_id IS NULL) skips this fixture.
  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, status, session_id)
    VALUES (${bizId}, 'gccomplete-goal', 'active', 'gs-gccomplete-fixture')
    RETURNING *
  `;
  goalId = goal.id;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.OPENCLAW_CONFIG_PATH;
  process.env.VITEST = "true";
  delete process.env.INTERNAL_SERVICE_TOKEN;
  authState.authHeader = null;
  authState.sessionUser = null;
});

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3002/api/goals/test/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function completionBody(summary: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary,
    evidence: [
      {
        type: "artifact",
        description: "Verified completion artifact exists.",
        reference: "workspace://verified-artifact",
        verified: true,
      },
    ],
    learningGate: {
      category: "nothing",
      rationale: "No reusable learning should be saved from this goal.",
    },
    ...extra,
  };
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function seedSessionUser(
  userId: string,
  email: string,
  isSystemOwner: boolean,
  membershipRole?: "member" | "viewer",
) {
  await sql`
    INSERT INTO users (id, email, password_hash, is_system_owner)
    VALUES (${userId}::uuid, ${email}, 'test-hash', ${isSystemOwner})
  `;
  if (membershipRole) {
    await sql`
      INSERT INTO hive_memberships (user_id, hive_id, role)
      VALUES (${userId}::uuid, ${bizId}::uuid, ${membershipRole})
    `;
  }
  process.env.VITEST = "false";
  authState.authHeader = null;
  authState.sessionUser = { email };
}

async function attachProjectToGoal(options: { gitRepo: boolean }) {
  const slug = options.gitRepo ? "gccomplete-git-project" : "gccomplete-project";
  const [project] = await sql`
    INSERT INTO projects (hive_id, slug, name, git_repo)
    VALUES (${bizId}, ${slug}, ${slug}, ${options.gitRepo})
    RETURNING id
  `;
  await sql`
    UPDATE goals
    SET project_id = ${project.id}
    WHERE id = ${goalId}
  `;
  return project.id as string;
}

describe("POST /api/goals/[id]/complete", () => {
  it("skips landed-state enforcement for a non-repository goal", async () => {
    vi.mocked(gate.verifyLandedState).mockResolvedValue({
      ok: false,
      failures: ["Expected a clean working tree before completion."],
    });

    const res = await POST(
      makeRequest(completionBody("gccomplete: non-repo goal completes")),
      makeParams(goalId),
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(gate.verifyLandedState)).not.toHaveBeenCalled();

    const body = await res.json();
    expect(body.data.status).toBe("achieved");
  });

  it("enforces landed-state checks for git-backed project goals", async () => {
    await attachProjectToGoal({ gitRepo: true });
    vi.mocked(gate.verifyLandedState).mockResolvedValue({
      ok: false,
      failures: ["Expected a clean working tree before completion."],
    });

    const res = await POST(
      makeRequest(completionBody("gccomplete: repo goal blocked by landed state")),
      makeParams(goalId),
    );
    expect(res.status).toBe(500);
    expect(vi.mocked(gate.verifyLandedState)).toHaveBeenCalledTimes(1);
    await expect(res.json()).resolves.toMatchObject({
      error: "Failed to complete goal",
    });

    const [goal] = await sql`SELECT status FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("active");
  });

  it("completes an active goal and returns achieved state with latestCompletion", async () => {
    const res = await POST(
      makeRequest(completionBody("gccomplete: all criteria met")),
      makeParams(goalId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.goalId).toBe(goalId);
    expect(body.data.status).toBe("achieved");
    expect(body.data.idempotent).toBe(false);
    // Happy path also returns latestCompletion (symmetric with idempotent branch — fix #2 in e04d368)
    expect(body.data.latestCompletion).toBeTruthy();
    expect(body.data.latestCompletion.summary).toBe("gccomplete: all criteria met");

    // Side effects landed: status flipped, session cleared, audit row written
    const [goal] = await sql`SELECT status, session_id FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("achieved");
    expect(goal.session_id).toBeNull();

    const completions = await sql`SELECT * FROM goal_completions WHERE goal_id = ${goalId}`;
    expect(completions.length).toBe(1);
    expect(completions[0].summary).toBe("gccomplete: all criteria met");
  });

  it("marks ready-to-send outreach as blocked_on_owner_channel instead of achieved", async () => {
    const res = await POST(
      makeRequest(completionBody("Outreach package is ready to send; owner LinkedIn channel approval is required", {
        completionStatus: "blocked_on_owner_channel",
        evidence: [
          {
            type: "outreach_queue",
            description: "Five LinkedIn outreach messages are ready-to-send but NOT SENT.",
            value: "Queue status: NOT SENT; awaiting owner manual send from personal LinkedIn channel.",
            verified: true,
          },
        ],
      })),
      makeParams(goalId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("blocked_on_owner_channel");
    expect(body.data.idempotent).toBe(false);

    const [goal] = await sql`SELECT status, session_id FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("blocked_on_owner_channel");
    expect(goal.session_id).toBeNull();

    const [memory] = await sql`SELECT content FROM hive_memory WHERE hive_id = ${bizId} ORDER BY created_at DESC LIMIT 1`;
    expect(memory.content).toContain("status blocked_on_owner_channel");
  });

  it("allows a real system-owner session to complete without supervisor session proof", async () => {
    await seedSessionUser(OWNER_USER_ID, "owner-goals-complete@test.local", true);

    const res = await POST(
      makeRequest(completionBody("gccomplete: real owner session")),
      makeParams(goalId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("achieved");
  });

  it("rejects internal bearer service-account completion without supervisor session proof", async () => {
    process.env.VITEST = "false";
    process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
    authState.authHeader = `Bearer ${INTERNAL_TOKEN}`;

    const res = await POST(
      makeRequest(completionBody("gccomplete: bearer without supervisor proof")),
      makeParams(goalId),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/supervisor session/i);

    const [goal] = await sql`SELECT status FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("active");
    const completions = await sql`SELECT id FROM goal_completions WHERE goal_id = ${goalId}`;
    expect(completions.length).toBe(0);
  });

  it("rejects internal bearer service-account completion with mismatched supervisor session proof", async () => {
    process.env.VITEST = "false";
    process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
    authState.authHeader = `Bearer ${INTERNAL_TOKEN}`;

    const res = await POST(
      makeRequest(
        completionBody("gccomplete: bearer with wrong supervisor proof"),
        { "X-Supervisor-Session": "gs-wrong-fixture" },
      ),
      makeParams(goalId),
    );
    expect(res.status).toBe(403);

    const [goal] = await sql`SELECT status FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("active");
  });

  it("allows internal bearer service-account completion with matching supervisor session proof", async () => {
    process.env.VITEST = "false";
    process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
    authState.authHeader = `Bearer ${INTERNAL_TOKEN}`;

    const res = await POST(
      makeRequest(
        completionBody("gccomplete: bearer with supervisor proof"),
        { "X-Supervisor-Session": "gs-gccomplete-fixture" },
      ),
      makeParams(goalId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("achieved");

    const [completion] = await sql`SELECT created_by FROM goal_completions WHERE goal_id = ${goalId}`;
    expect(completion.created_by).toBe("goal-supervisor");
  });

  it("rejects a non-owner member session without matching supervisor session proof", async () => {
    await seedSessionUser(
      MEMBER_USER_ID,
      "member-goals-complete@test.local",
      false,
      "member",
    );

    const res = await POST(
      makeRequest(completionBody("gccomplete: member no supervisor proof")),
      makeParams(goalId),
    );
    expect(res.status).toBe(403);

    const [goal] = await sql`SELECT status FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("active");
  });

  it("persists evidence task and work-product IDs on the audit row", async () => {
    const taskId = (await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id)
      VALUES (${bizId}, 'gccomplete-role', 'system', 'gccomplete-evidence-task', 'b', ${goalId})
      RETURNING id
    `)[0].id;

    const res = await POST(
      makeRequest(completionBody("gccomplete: with evidence", {
        evidence: undefined,
        evidenceTaskIds: [taskId],
        evidenceWorkProductIds: ["wp-fake-uuid-for-test"],
      })),
      makeParams(goalId),
    );
    expect(res.status).toBe(200);

    const [completion] = await sql`SELECT evidence FROM goal_completions WHERE goal_id = ${goalId}`;
    expect(completion.evidence).toEqual({
      taskIds: [taskId],
      workProductIds: ["wp-fake-uuid-for-test"],
    });
  });

  it("persists a required evidence bundle", async () => {
    const evidence = [
      {
        type: "artifact",
        description: "Built artifact is available for inspection.",
        reference: "https://preview.example.test/goal",
        verified: true,
      },
      {
        type: "test",
        description: "Smoke test passed.",
        value: "npm run typecheck",
      },
    ];

    const res = await POST(
      makeRequest(completionBody("gccomplete: with evidence bundle", {
        evidence,
      })),
      makeParams(goalId),
    );
    expect(res.status).toBe(200);

    const [completion] = await sql`SELECT evidence FROM goal_completions WHERE goal_id = ${goalId}`;
    expect(completion.evidence).toEqual({ bundle: evidence });
  });

  it("persists a learning gate result on completion", async () => {
    const res = await POST(
      makeRequest(completionBody("gccomplete: with learning gate", {
        learningGate: {
          category: "pipeline_candidate",
          rationale: "This successful launch sequence may be worth repeatable governance.",
          action: "Draft a candidate launch pipeline for owner review.",
        },
      })),
      makeParams(goalId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.latestCompletion.learning_gate).toEqual({
      category: "pipeline_candidate",
      rationale: "This successful launch sequence may be worth repeatable governance.",
      action: "Draft a candidate launch pipeline for owner review.",
    });

    const [completion] = await sql`SELECT learning_gate FROM goal_completions WHERE goal_id = ${goalId}`;
    expect(completion.learning_gate).toEqual({
      category: "pipeline_candidate",
      rationale: "This successful launch sequence may be worth repeatable governance.",
      action: "Draft a candidate launch pipeline for owner review.",
    });
  });

  it("rejects unsupported learning gate categories", async () => {
    const res = await POST(
      makeRequest(completionBody("gccomplete: bad learning gate", {
        learningGate: {
          category: "interesting",
          rationale: "Unsupported category.",
        },
      })),
      makeParams(goalId),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/learningGate/i);

    const [goal] = await sql`SELECT status FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("active");
    const completions = await sql`SELECT id FROM goal_completions WHERE goal_id = ${goalId}`;
    expect(completions.length).toBe(0);
  });

  it("uses provided createdBy when supplied", async () => {
    const res = await POST(
      makeRequest(completionBody("gccomplete: by owner override", { createdBy: "owner" })),
      makeParams(goalId),
    );
    expect(res.status).toBe(200);

    const [completion] = await sql`SELECT created_by FROM goal_completions WHERE goal_id = ${goalId}`;
    expect(completion.created_by).toBe("owner");
  });

  it("returns 400 for missing summary", async () => {
    const res = await POST(makeRequest(completionBody("", { summary: undefined })), makeParams(goalId));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/summary/i);

    const [goal] = await sql`SELECT status FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("active"); // not mutated
  });

  it("returns 400 for whitespace-only summary", async () => {
    const res = await POST(makeRequest(completionBody("   ")), makeParams(goalId));
    expect(res.status).toBe(400);
  });

  it("returns 400 when completion evidence is missing or empty", async () => {
    const missing = await POST(
      makeRequest(completionBody("gccomplete: missing evidence", { evidence: undefined })),
      makeParams(goalId),
    );
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({
      error: expect.stringMatching(/evidence/i),
    });

    const empty = await POST(
      makeRequest(completionBody("gccomplete: empty evidence", { evidence: [] })),
      makeParams(goalId),
    );
    expect(empty.status).toBe(400);

    const [goal] = await sql`SELECT status FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("active");
    const completions = await sql`SELECT id FROM goal_completions WHERE goal_id = ${goalId}`;
    expect(completions.length).toBe(0);
  });

  it("returns 400 when learning gate is missing", async () => {
    const res = await POST(
      makeRequest(completionBody("gccomplete: missing learning gate", { learningGate: undefined })),
      makeParams(goalId),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/learningGate/i);

    const [goal] = await sql`SELECT status FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("active");
    const completions = await sql`SELECT id FROM goal_completions WHERE goal_id = ${goalId}`;
    expect(completions.length).toBe(0);
  });

  it("returns 400 for non-string-array evidenceTaskIds", async () => {
    const res = await POST(
      makeRequest(completionBody("gccomplete: bad evidence", { evidenceTaskIds: "not-an-array" })),
      makeParams(goalId),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/evidenceTaskIds/);
  });

  it("returns 400 for empty-string createdBy", async () => {
    const res = await POST(
      makeRequest(completionBody("gccomplete: bad createdBy", { createdBy: "" })),
      makeParams(goalId),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/createdBy/);

    const [goal] = await sql`SELECT status FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("active"); // not mutated
  });

  it("returns 404 for missing goal", async () => {
    const res = await POST(
      makeRequest(completionBody("gccomplete: not real")),
      makeParams("00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 for cancelled goal", async () => {
    await sql`UPDATE goals SET status = 'cancelled' WHERE id = ${goalId}`;
    const res = await POST(
      makeRequest(completionBody("gccomplete: should not resurrect")),
      makeParams(goalId),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/status.*cancelled/i);

    // Status not mutated by the rejected call.
    const [goal] = await sql`SELECT status FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("cancelled");

    // No audit row written.
    const completions = await sql`SELECT * FROM goal_completions WHERE goal_id = ${goalId}`;
    expect(completions.length).toBe(0);
  });

  it("returns 409 for paused goal", async () => {
    await sql`UPDATE goals SET status = 'paused' WHERE id = ${goalId}`;
    const res = await POST(
      makeRequest(completionBody("gccomplete: paused too")),
      makeParams(goalId),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/status.*paused/i);
  });

  it("is idempotent — second call returns latest completion without re-running side effects", async () => {
    // First call
    await POST(
      makeRequest(completionBody("gccomplete: first call")),
      makeParams(goalId),
    );
    const firstCompletions = await sql`SELECT id FROM goal_completions WHERE goal_id = ${goalId}`;
    const firstMemoryCount = (await sql`
      SELECT COUNT(*)::int AS c FROM hive_memory
      WHERE hive_id = ${bizId} AND content LIKE '%gccomplete%'
    `)[0].c;

    // Second call (would double-write memory + double-fire notification if not idempotent)
    const res = await POST(
      makeRequest(completionBody("gccomplete: second call should not duplicate")),
      makeParams(goalId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.idempotent).toBe(true);
    expect(body.data.latestCompletion).toBeTruthy();
    expect(body.data.latestCompletion.summary).toBe("gccomplete: first call");

    const secondCompletions = await sql`SELECT id FROM goal_completions WHERE goal_id = ${goalId}`;
    expect(secondCompletions.length).toBe(firstCompletions.length); // no new audit row
    const secondMemoryCount = (await sql`
      SELECT COUNT(*)::int AS c FROM hive_memory
      WHERE hive_id = ${bizId} AND content LIKE '%gccomplete%'
    `)[0].c;
    expect(secondMemoryCount).toBe(firstMemoryCount); // no new memory row
  });
});
