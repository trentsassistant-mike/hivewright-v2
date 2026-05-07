import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { POST } from "@/app/api/goals/[id]/complete/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;
let goalId: string;
let tmp: string;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goals-complete-"));
  const cfgPath = path.join(tmp, "openclaw.json");
  fs.writeFileSync(cfgPath, JSON.stringify({ agents: { list: [] } }));
  process.env.OPENCLAW_CONFIG_PATH = cfgPath;

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
});

function makeRequest(body: unknown): Request {
  return new Request("http://localhost:3002/api/goals/test/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/goals/[id]/complete", () => {
  it("completes an active goal and returns achieved state with latestCompletion", async () => {
    const res = await POST(
      makeRequest({ summary: "gccomplete: all criteria met" }),
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

  it("persists evidence task and work-product IDs on the audit row", async () => {
    const taskId = (await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, goal_id)
      VALUES (${bizId}, 'gccomplete-role', 'system', 'gccomplete-evidence-task', 'b', ${goalId})
      RETURNING id
    `)[0].id;

    const res = await POST(
      makeRequest({
        summary: "gccomplete: with evidence",
        evidenceTaskIds: [taskId],
        evidenceWorkProductIds: ["wp-fake-uuid-for-test"],
      }),
      makeParams(goalId),
    );
    expect(res.status).toBe(200);

    const [completion] = await sql`SELECT evidence FROM goal_completions WHERE goal_id = ${goalId}`;
    expect(completion.evidence).toEqual({
      taskIds: [taskId],
      workProductIds: ["wp-fake-uuid-for-test"],
    });
  });

  it("uses provided createdBy when supplied", async () => {
    const res = await POST(
      makeRequest({ summary: "gccomplete: by owner override", createdBy: "owner" }),
      makeParams(goalId),
    );
    expect(res.status).toBe(200);

    const [completion] = await sql`SELECT created_by FROM goal_completions WHERE goal_id = ${goalId}`;
    expect(completion.created_by).toBe("owner");
  });

  it("returns 400 for missing summary", async () => {
    const res = await POST(makeRequest({}), makeParams(goalId));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/summary/i);

    const [goal] = await sql`SELECT status FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("active"); // not mutated
  });

  it("returns 400 for whitespace-only summary", async () => {
    const res = await POST(makeRequest({ summary: "   " }), makeParams(goalId));
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-string-array evidenceTaskIds", async () => {
    const res = await POST(
      makeRequest({ summary: "gccomplete: bad evidence", evidenceTaskIds: "not-an-array" }),
      makeParams(goalId),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/evidenceTaskIds/);
  });

  it("returns 400 for empty-string createdBy", async () => {
    const res = await POST(
      makeRequest({ summary: "gccomplete: bad createdBy", createdBy: "" }),
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
      makeRequest({ summary: "gccomplete: not real" }),
      makeParams("00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(404);
  });

  it("returns 409 for cancelled goal", async () => {
    await sql`UPDATE goals SET status = 'cancelled' WHERE id = ${goalId}`;
    const res = await POST(
      makeRequest({ summary: "gccomplete: should not resurrect" }),
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
      makeRequest({ summary: "gccomplete: paused too" }),
      makeParams(goalId),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/status.*paused/i);
  });

  it("is idempotent — second call returns latest completion without re-running side effects", async () => {
    // First call
    await POST(
      makeRequest({ summary: "gccomplete: first call" }),
      makeParams(goalId),
    );
    const firstCompletions = await sql`SELECT id FROM goal_completions WHERE goal_id = ${goalId}`;
    const firstMemoryCount = (await sql`
      SELECT COUNT(*)::int AS c FROM hive_memory
      WHERE hive_id = ${bizId} AND content LIKE '%gccomplete%'
    `)[0].c;

    // Second call (would double-write memory + double-fire notification if not idempotent)
    const res = await POST(
      makeRequest({ summary: "gccomplete: second call should not duplicate" }),
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
