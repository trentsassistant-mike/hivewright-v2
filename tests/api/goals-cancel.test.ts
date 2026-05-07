import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { POST } from "../../src/app/api/goals/[id]/cancel/route";

const BIZ = "11111111-1111-1111-1111-111111111111";
let tmp: string;

beforeEach(async () => {
  await truncateAll(sql);
  // Sandbox openclaw so pruneGoalSupervisor doesn't touch ~/.openclaw
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goals-cancel-"));
  fs.writeFileSync(path.join(tmp, "openclaw.json"), JSON.stringify({ agents: { list: [] } }));
  process.env.OPENCLAW_CONFIG_PATH = path.join(tmp, "openclaw.json");
  await sql`INSERT INTO hives (id, slug, name, type) VALUES (${BIZ}, 'biz', 'Biz', 'digital')`;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.OPENCLAW_CONFIG_PATH;
});

async function insertGoal(status: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO goals (hive_id, title, status)
    VALUES (${BIZ}, 'g', ${status})
    RETURNING id
  `;
  return row.id;
}

function cancelRequest(id: string, body: unknown = { reason: "owner cancelled" }): Request {
  return new Request(`http://x/api/goals/${id}/cancel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-HiveWright-EA-Source-Hive-Id": BIZ,
      "X-HiveWright-EA-Thread-Id": "thread-1",
      "X-HiveWright-EA-Owner-Message-Id": "message-1",
      "X-HiveWright-EA-Source": "dashboard",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/goals/[id]/cancel", () => {
  it("transitions active -> cancelled, clears supervisor session, writes goal comment", async () => {
    const id = await insertGoal("active");
    await sql`UPDATE goals SET session_id = ${`hw-gs-biz-${id.slice(0, 8)}`} WHERE id = ${id}`;

    const req = cancelRequest(id);
    const res = await POST(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("cancelled");
    expect(body.data.goalId).toBe(id);
    expect(body.data.supervisorSessionEnded).toBe(true);

    const [g] = await sql<{ status: string; session_id: string | null }[]>`
      SELECT status, session_id FROM goals WHERE id = ${id}
    `;
    expect(g.status).toBe("cancelled");
    expect(g.session_id).toBeNull();

    const [comment] = await sql<{ body: string; created_by: string }[]>`
      SELECT body, created_by FROM goal_comments WHERE goal_id = ${id}
    `;
    expect(comment.body).toContain("cancelled");
    expect(comment.body).toContain("owner cancelled");
    expect(comment.created_by).toBe("ea");
  });

  it("requires a reason", async () => {
    const id = await insertGoal("active");
    const res = await POST(cancelRequest(id, {}), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(400);
  });

  it("rejects with 409 when status is already terminal", async () => {
    const id = await insertGoal("achieved");
    const res = await POST(cancelRequest(id), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(409);
  });

  it("returns 404 for an unknown goal id", async () => {
    const req = cancelRequest("00000000-0000-0000-0000-000000000000");
    const res = await POST(req, { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) });
    expect(res.status).toBe(404);
  });
});
