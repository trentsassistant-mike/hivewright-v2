import { describe, it, expect, beforeEach } from "vitest";
import { GET as getPlan, PUT as putPlan } from "@/app/api/goals/[id]/documents/plan/route";
import { GET as getDocuments } from "@/app/api/goals/[id]/documents/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const PREFIX = "gdoc-api-";
let hiveId: string;
let goalId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES (${PREFIX + "biz"}, 'GDoc API Test', 'digital')
    RETURNING id
  `;
  hiveId = biz.id as string;

  // session_id set to block a running dispatcher from picking up this fixture
  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, status, session_id)
    VALUES (${hiveId}, ${PREFIX + "goal"}, 'active', 'gs-gdoc-api-fixture')
    RETURNING id
  `;
  goalId = goal.id as string;
});

// Helper to build the `params` Promise Next.js passes to route handlers
function paramsFor(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/goals/:id/documents/plan", () => {
  it("returns 404 when no plan exists", async () => {
    const req = new Request(`http://localhost/api/goals/${goalId}/documents/plan`);
    const res = await getPlan(req, paramsFor(goalId));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/no plan/i);
  });
});

describe("PUT /api/goals/:id/documents/plan", () => {
  it("rejects missing title with 400", async () => {
    const req = new Request(`http://localhost/api/goals/${goalId}/documents/plan`, {
      method: "PUT",
      body: JSON.stringify({ body: "only body, no title" }),
    });
    const res = await putPlan(req, paramsFor(goalId));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/title.*body.*required/i);
  });

  it("rejects missing body with 400", async () => {
    const req = new Request(`http://localhost/api/goals/${goalId}/documents/plan`, {
      method: "PUT",
      body: JSON.stringify({ title: "only title" }),
    });
    const res = await putPlan(req, paramsFor(goalId));
    expect(res.status).toBe(400);
  });

  it("rejects body larger than 1 MiB with 413", async () => {
    const hugeBody = "x".repeat(1_048_577); // 1 MiB + 1 byte
    const req = new Request(`http://localhost/api/goals/${goalId}/documents/plan`, {
      method: "PUT",
      body: JSON.stringify({ title: "huge", body: hugeBody }),
    });
    const res = await putPlan(req, paramsFor(goalId));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toMatch(/exceeds/i);
  });

  it("returns 404 when the goal id does not exist", async () => {
    const fakeGoalId = "00000000-0000-0000-0000-000000000000";
    const req = new Request(`http://localhost/api/goals/${fakeGoalId}/documents/plan`, {
      method: "PUT",
      body: JSON.stringify({ title: "no goal", body: "# body" }),
    });
    const res = await putPlan(req, paramsFor(fakeGoalId));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/goal not found/i);
  });

  it("creates a plan on first PUT", async () => {
    const req = new Request(`http://localhost/api/goals/${goalId}/documents/plan`, {
      method: "PUT",
      body: JSON.stringify({
        title: `${PREFIX}plan`,
        body: "# Goal Summary\nShip it.",
        createdBy: "owner",
      }),
    });
    const res = await putPlan(req, paramsFor(goalId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe(`${PREFIX}plan`);
    expect(body.revision).toBe(1);
    expect(body.createdBy).toBe("owner");
  });

  it("updates the plan and bumps revision on second PUT", async () => {
    // Create the plan first (revision 1)
    await putPlan(
      new Request(`http://localhost/api/goals/${goalId}/documents/plan`, {
        method: "PUT",
        body: JSON.stringify({ title: `${PREFIX}plan`, body: "# Goal Summary\nShip it.", createdBy: "owner" }),
      }),
      paramsFor(goalId),
    );
    // Now update (should be revision 2)
    const req = new Request(`http://localhost/api/goals/${goalId}/documents/plan`, {
      method: "PUT",
      body: JSON.stringify({
        title: `${PREFIX}plan`,
        body: "# Goal Summary\nShip it harder.",
      }),
    });
    const res = await putPlan(req, paramsFor(goalId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revision).toBe(2);
    expect(body.body).toContain("Ship it harder.");
  });
});

describe("GET /api/goals/:id/documents/plan (after plan exists)", () => {
  it("returns the plan with 200 when one exists", async () => {
    // Create the plan first
    await putPlan(
      new Request(`http://localhost/api/goals/${goalId}/documents/plan`, {
        method: "PUT",
        body: JSON.stringify({ title: `${PREFIX}plan`, body: "# Goal Summary\nShip it.", createdBy: "owner" }),
      }),
      paramsFor(goalId),
    );
    // Update to get revision 2
    await putPlan(
      new Request(`http://localhost/api/goals/${goalId}/documents/plan`, {
        method: "PUT",
        body: JSON.stringify({ title: `${PREFIX}plan`, body: "# Goal Summary\nShip it harder." }),
      }),
      paramsFor(goalId),
    );

    const req = new Request(`http://localhost/api/goals/${goalId}/documents/plan`);
    const res = await getPlan(req, paramsFor(goalId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe(`${PREFIX}plan`);
    expect(body.revision).toBe(2);
  });
});

describe("GET /api/goals/:id/documents", () => {
  it("returns all documents for the goal", async () => {
    // Create a plan so there is something to list
    await putPlan(
      new Request(`http://localhost/api/goals/${goalId}/documents/plan`, {
        method: "PUT",
        body: JSON.stringify({ title: `${PREFIX}plan`, body: "# Goal Summary\nShip it.", createdBy: "owner" }),
      }),
      paramsFor(goalId),
    );

    const req = new Request(`http://localhost/api/goals/${goalId}/documents`);
    const res = await getDocuments(req, paramsFor(goalId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents).toBeDefined();
    expect(Array.isArray(body.documents)).toBe(true);
    expect(body.documents.length).toBe(1);
    expect(body.documents[0].documentType).toBe("plan");
  });
});
