import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createComment } from "@/app/api/goals/[id]/comments/route";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const authState = vi.hoisted(() => ({
  authHeader: null as string | null,
  supervisorSession: null as string | null,
  sessionUser: null as { email: string } | null,
}));

vi.mock("next/headers", () => ({
  headers: async () => {
    const headers = new Headers();
    if (authState.authHeader) headers.set("authorization", authState.authHeader);
    if (authState.supervisorSession) {
      headers.set("x-supervisor-session", authState.supervisorSession);
    }
    return headers;
  },
}));

vi.mock("@/auth", () => ({
  auth: async () => (authState.sessionUser ? { user: authState.sessionUser } : null),
}));

const INTERNAL_TOKEN = "goal-comments-attribution-token";
const OWNER_USER_ID = "11111111-2222-4333-8444-555555555555";
const MEMBER_USER_ID = "22222222-3333-4444-8555-666666666666";
const VIEWER_USER_ID = "33333333-4444-4555-8666-777777777777";
let hiveId: string;
let goalId: string;
let supervisorSessionId: string;

function makeRequest(body: Record<string, unknown>, supervisorSession?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (supervisorSession) headers["x-supervisor-session"] = supervisorSession;
  return new Request("http://localhost/api/goals/x/comments", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe.sequential("POST /api/goals/[id]/comments — internal-service-account attribution", () => {
  beforeEach(async () => {
    process.env.VITEST = "false";
    process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
    authState.authHeader = `Bearer ${INTERNAL_TOKEN}`;
    authState.supervisorSession = null;
    authState.sessionUser = null;

    await truncateAll(sql);
    const [hive] = await sql<{ id: string }[]>`
      INSERT INTO hives (slug, name, type)
      VALUES ('comments-attribution', 'Comments Attribution', 'digital')
      RETURNING id
    `;
    hiveId = hive.id;
    supervisorSessionId = "session-abc-123";
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, description, status, session_id)
      VALUES (${hiveId}, 'Test Goal', 'Goal under test', 'active', ${supervisorSessionId})
      RETURNING id
    `;
    goalId = goal.id;
  });

  afterEach(() => {
    process.env.VITEST = "true";
    delete process.env.INTERNAL_SERVICE_TOKEN;
    authState.authHeader = null;
    authState.supervisorSession = null;
    authState.sessionUser = null;
  });

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
        VALUES (${userId}::uuid, ${hiveId}::uuid, ${membershipRole})
      `;
    }
    authState.authHeader = null;
    authState.sessionUser = { email };
  }

  it("attributes EA-style comments (internal token, no createdBy) as 'system', not 'owner'", async () => {
    const response = await createComment(
      makeRequest({ body: "EA decided to retry the task with a fresh role." }),
      { params: Promise.resolve({ id: goalId }) },
    );
    expect(response.status).toBe(201);
    const json = (await response.json()) as { data: { comment: { createdBy: string; body: string } } };
    expect(json.data.comment.createdBy).toBe("system");
    expect(json.data.comment.body).toContain("EA decided");

    const [row] = await sql<{ created_by: string }[]>`
      SELECT created_by FROM goal_comments WHERE goal_id = ${goalId}
    `;
    expect(row.created_by).toBe("system");
  });

  it("rejects an explicit createdBy='owner' from the internal-service-account caller", async () => {
    const response = await createComment(
      makeRequest({ body: "Sneaky EA pretending to be owner.", createdBy: "owner" }),
      { params: Promise.resolve({ id: goalId }) },
    );
    expect(response.status).toBe(201);
    const json = (await response.json()) as { data: { comment: { createdBy: string } } };
    expect(json.data.comment.createdBy).toBe("system");
  });

  it("preserves goal-supervisor attribution when x-supervisor-session matches", async () => {
    authState.supervisorSession = supervisorSessionId;
    const response = await createComment(
      makeRequest(
        { body: "Supervisor reflection note." },
        supervisorSessionId,
      ),
      { params: Promise.resolve({ id: goalId }) },
    );
    expect(response.status).toBe(201);
    const json = (await response.json()) as { data: { comment: { createdBy: string } } };
    expect(json.data.comment.createdBy).toBe("goal-supervisor");
  });

  it("honors a non-owner caller-supplied createdBy from the internal-service-account", async () => {
    const response = await createComment(
      makeRequest({ body: "Doctor escalation note.", createdBy: "doctor" }),
      { params: Promise.resolve({ id: goalId }) },
    );
    expect(response.status).toBe(201);
    const json = (await response.json()) as { data: { comment: { createdBy: string } } };
    expect(json.data.comment.createdBy).toBe("doctor");
  });

  it("attributes real system-owner session comments as 'owner' by default", async () => {
    await seedSessionUser(OWNER_USER_ID, "owner-comments-attribution@test.local", true);

    const response = await createComment(
      makeRequest({ body: "Owner approval note." }),
      { params: Promise.resolve({ id: goalId }) },
    );
    expect(response.status).toBe(201);
    const json = (await response.json()) as { data: { comment: { createdBy: string } } };
    expect(json.data.comment.createdBy).toBe("owner");
  });

  it("allows same-hive member comments but forces system attribution", async () => {
    await seedSessionUser(
      MEMBER_USER_ID,
      "member-comments-attribution@test.local",
      false,
      "member",
    );

    const response = await createComment(
      makeRequest({ body: "Member operational note.", createdBy: "owner" }),
      { params: Promise.resolve({ id: goalId }) },
    );
    expect(response.status).toBe(201);
    const json = (await response.json()) as { data: { comment: { createdBy: string } } };
    expect(json.data.comment.createdBy).toBe("system");
  });

  it("rejects same-hive viewer comments", async () => {
    await seedSessionUser(
      VIEWER_USER_ID,
      "viewer-comments-attribution@test.local",
      false,
      "viewer",
    );

    const response = await createComment(
      makeRequest({ body: "Viewer write attempt." }),
      { params: Promise.resolve({ id: goalId }) },
    );
    expect(response.status).toBe(403);

    const rows = await sql`
      SELECT id FROM goal_comments WHERE goal_id = ${goalId} AND body = 'Viewer write attempt.'
    `;
    expect(rows.length).toBe(0);
  });
});
