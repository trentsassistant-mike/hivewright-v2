import { describe, it, expect, beforeEach, vi } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";

// Default test bypass in src/app/api/_lib/auth.ts forces isSystemOwner=true,
// which hides the per-handler authorization branches (session-match on
// goals.complete, role gate on tasks POST). These tests override that
// bypass via vi.mock so the non-owner branches are reachable.
const authState = vi.hoisted(() => ({
  unauthenticated: false,
  isSystemOwner: true,
  userId: "test-user",
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

vi.mock("@/app/api/_lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/api/_lib/auth")>();
  return {
    __actual: actual,
    ...actual,
    requireApiAuth: async () => null,
    requireApiUser: async () => {
      if (authState.unauthenticated) {
        const { NextResponse } = await import("next/server");
        return {
          response: NextResponse.json(
            { error: "Unauthorized" },
            { status: 401 },
          ),
        };
      }
      return {
        user: {
          id: authState.userId,
          email: "test@local",
          isSystemOwner: authState.isSystemOwner,
        },
      };
    },
    requireSystemOwner: async () => {
      if (!authState.isSystemOwner) {
        const { NextResponse } = await import("next/server");
        return {
          response: NextResponse.json(
            { error: "Forbidden: system owner role required" },
            { status: 403 },
          ),
        };
      }
      return {
        user: { id: "test-user", email: "test@local", isSystemOwner: true },
      };
    },
  };
});

// Imports after vi.mock so the routes bind to the mocked auth module.
import { POST as completeGoal } from "@/app/api/goals/[id]/complete/route";
import {
  GET as getGoalComments,
  POST as postGoalComment,
} from "@/app/api/goals/[id]/comments/route";
import { POST as cancelGoal } from "@/app/api/goals/[id]/cancel/route";
import { GET as getGoalDocuments } from "@/app/api/goals/[id]/documents/route";
import { GET as getGoalPlan } from "@/app/api/goals/[id]/documents/plan/route";
import { POST as createTask } from "@/app/api/tasks/route";
import { POST as createWork } from "@/app/api/work/route";
import { POST as createCredential } from "@/app/api/credentials/route";
import { DELETE as deleteCredential } from "@/app/api/credentials/[id]/route";
import { POST as restartDispatcher } from "@/app/api/dispatcher/restart/route";
import { GET as downloadAttachment } from "@/app/api/attachments/[id]/download/route";
import * as authModule from "@/app/api/_lib/auth";
import fs from "fs";
import path from "path";

const PREFIX = "auth-guards-";
const MEMBER_USER_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_MEMBER_USER_ID = "22222222-3333-4444-8555-666666666666";
const VIEWER_USER_ID = "33333333-4444-4555-8666-777777777777";
let hiveId: string;
let otherHiveId: string;
let goalId: string;
const GOAL_SESSION = "gs-auth-guards-fixture";

beforeEach(async () => {
  authState.unauthenticated = false;
  authState.isSystemOwner = true;
  authState.userId = "test-user";
  authState.authHeader = null;
  authState.sessionUser = null;
  process.env.VITEST = "true";
  delete process.env.INTERNAL_SERVICE_TOKEN;
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES (${PREFIX + "biz"}, 'Auth Guards Test', 'digital')
    RETURNING id
  `;
  hiveId = biz.id;

  const [otherBiz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES (${PREFIX + "other-biz"}, 'Auth Guards Other', 'digital')
    RETURNING id
  `;
  otherHiveId = otherBiz.id;

  const [goal] = await sql`
    INSERT INTO goals (hive_id, title, status, session_id)
    VALUES (${hiveId}, 'auth-guards-goal', 'active', ${GOAL_SESSION})
    RETURNING id
  `;
  goalId = goal.id;
});

function getActualAuthModule(): typeof import("@/app/api/_lib/auth") {
  return (authModule as typeof authModule & { __actual: typeof import("@/app/api/_lib/auth") }).__actual;
}

function completeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/goals/x/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function seedUserMembership(
  userId: string,
  targetHiveId: string,
  role: "owner" | "member" | "viewer",
): Promise<void> {
  await sql`
    INSERT INTO users (id, email, password_hash, is_system_owner)
    VALUES (${userId}::uuid, ${`${userId}@auth-guards.test`}, 'test-hash', false)
  `;
  await sql`
    INSERT INTO hive_memberships (user_id, hive_id, role)
    VALUES (${userId}::uuid, ${targetHiveId}::uuid, ${role})
  `;
}

async function seedGoalReadFixtures(): Promise<void> {
  await sql`
    INSERT INTO goal_comments (goal_id, body, created_by)
    VALUES (${goalId}, 'seeded comment', 'owner')
  `;
  await sql`
    INSERT INTO goal_documents (goal_id, document_type, title, format, body, revision, created_by)
    VALUES (${goalId}, 'plan', 'Seeded plan', 'markdown', '# Plan', 1, 'owner')
  `;
}

function getRequest(path: string): Request {
  return new Request(`http://localhost${path}`, { method: "GET" });
}

function postJsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function goalLifecycleRequest(path: string, body: unknown, targetHiveId: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-HiveWright-EA-Source-Hive-Id": targetHiveId,
      "X-HiveWright-EA-Thread-Id": "44444444-5555-4666-8777-888888888888",
      "X-HiveWright-EA-Owner-Message-Id": "55555555-6666-4777-8888-999999999999",
      "X-HiveWright-EA-Source": "dashboard",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/goals/[id]/complete — session-match guard", () => {
  it("non-owner with mismatched X-Supervisor-Session is rejected with 403", async () => {
    authState.isSystemOwner = false;

    const res = await completeGoal(
      completeRequest(
        { summary: "should be blocked" },
        { "X-Supervisor-Session": "gs-some-other-session" },
      ),
      makeParams(goalId),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/supervisor session/i);

    // Goal must not be mutated and no audit row written.
    const [goal] = await sql`SELECT status FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("active");
    const completions = await sql`SELECT id FROM goal_completions WHERE goal_id = ${goalId}`;
    expect(completions.length).toBe(0);
  });

  it("non-owner with missing X-Supervisor-Session header is rejected with 403", async () => {
    authState.isSystemOwner = false;

    const res = await completeGoal(
      completeRequest({ summary: "no header at all" }),
      makeParams(goalId),
    );
    expect(res.status).toBe(403);

    const [goal] = await sql`SELECT status FROM goals WHERE id = ${goalId}`;
    expect(goal.status).toBe("active");
  });

  it("non-owner with matching X-Supervisor-Session completes the goal", async () => {
    authState.isSystemOwner = false;

    const res = await completeGoal(
      completeRequest(
        { summary: "matching session completes" },
        { "X-Supervisor-Session": GOAL_SESSION },
      ),
      makeParams(goalId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("achieved");
  });

  it("system owner completes without sending X-Supervisor-Session (bypass path)", async () => {
    // authState.isSystemOwner is true by default
    const res = await completeGoal(
      completeRequest({ summary: "owner bypass" }),
      makeParams(goalId),
    );
    expect(res.status).toBe(200);
  });
});

describe("goal document/comment reads — hive membership guard", () => {
  it.each([
    [
      "GET /api/goals/[id]/comments",
      () => getGoalComments(getRequest(`/api/goals/${goalId}/comments`), makeParams(goalId)),
    ],
    [
      "GET /api/goals/[id]/documents/plan",
      () => getGoalPlan(getRequest(`/api/goals/${goalId}/documents/plan`), makeParams(goalId)),
    ],
    [
      "GET /api/goals/[id]/documents",
      () => getGoalDocuments(getRequest(`/api/goals/${goalId}/documents`), makeParams(goalId)),
    ],
  ])("%s returns 401 without an authenticated user", async (_label, callRoute) => {
    authState.unauthenticated = true;
    await seedGoalReadFixtures();

    const res = await callRoute();
    expect(res.status).toBe(401);
  });

  it.each([
    [
      "GET /api/goals/[id]/comments",
      () => getGoalComments(getRequest(`/api/goals/${goalId}/comments`), makeParams(goalId)),
    ],
    [
      "GET /api/goals/[id]/documents/plan",
      () => getGoalPlan(getRequest(`/api/goals/${goalId}/documents/plan`), makeParams(goalId)),
    ],
    [
      "GET /api/goals/[id]/documents",
      () => getGoalDocuments(getRequest(`/api/goals/${goalId}/documents`), makeParams(goalId)),
    ],
  ])("%s returns 403 for a member of a different hive", async (_label, callRoute) => {
    authState.isSystemOwner = false;
    authState.userId = OTHER_MEMBER_USER_ID;
    await seedUserMembership(OTHER_MEMBER_USER_ID, otherHiveId, "member");
    await seedGoalReadFixtures();

    const res = await callRoute();
    expect(res.status).toBe(403);
  });

  it("allows a same-hive member to read comments, the plan, and document list", async () => {
    authState.isSystemOwner = false;
    authState.userId = MEMBER_USER_ID;
    await seedUserMembership(MEMBER_USER_ID, hiveId, "member");
    await seedGoalReadFixtures();

    const commentsRes = await getGoalComments(
      getRequest(`/api/goals/${goalId}/comments`),
      makeParams(goalId),
    );
    expect(commentsRes.status).toBe(200);
    await expect(commentsRes.json()).resolves.toMatchObject({
      data: { comments: [{ body: "seeded comment" }] },
    });

    const planRes = await getGoalPlan(
      getRequest(`/api/goals/${goalId}/documents/plan`),
      makeParams(goalId),
    );
    expect(planRes.status).toBe(200);
    await expect(planRes.json()).resolves.toMatchObject({
      title: "Seeded plan",
      documentType: "plan",
    });

    const documentsRes = await getGoalDocuments(
      getRequest(`/api/goals/${goalId}/documents`),
      makeParams(goalId),
    );
    expect(documentsRes.status).toBe(200);
    await expect(documentsRes.json()).resolves.toMatchObject({
      documents: [{ title: "Seeded plan", documentType: "plan" }],
    });
  });

  it.each([
    [
      "GET /api/goals/[id]/comments",
      () => getGoalComments(getRequest(`/api/goals/${goalId}/comments`), makeParams(goalId)),
    ],
    [
      "GET /api/goals/[id]/documents/plan",
      () => getGoalPlan(getRequest(`/api/goals/${goalId}/documents/plan`), makeParams(goalId)),
    ],
    [
      "GET /api/goals/[id]/documents",
      () => getGoalDocuments(getRequest(`/api/goals/${goalId}/documents`), makeParams(goalId)),
    ],
  ])("%s allows a same-hive viewer membership to read", async (_label, callRoute) => {
    authState.isSystemOwner = false;
    authState.userId = VIEWER_USER_ID;
    await seedUserMembership(VIEWER_USER_ID, hiveId, "viewer");
    await seedGoalReadFixtures();

    const res = await callRoute();
    expect(res.status).toBe(200);
  });
});

describe("goal write mutations — viewer role is read-only", () => {
  it("rejects a viewer membership for comment creation", async () => {
    authState.isSystemOwner = false;
    authState.userId = VIEWER_USER_ID;
    await seedUserMembership(VIEWER_USER_ID, hiveId, "viewer");

    const res = await postGoalComment(
      postJsonRequest(`/api/goals/${goalId}/comments`, { body: "viewer write attempt" }),
      makeParams(goalId),
    );
    expect(res.status).toBe(403);

    const rows = await sql`
      SELECT id FROM goal_comments WHERE goal_id = ${goalId} AND body = 'viewer write attempt'
    `;
    expect(rows.length).toBe(0);
  });

  it("rejects a viewer membership for goal cancellation", async () => {
    authState.isSystemOwner = false;
    authState.userId = VIEWER_USER_ID;
    await seedUserMembership(VIEWER_USER_ID, hiveId, "viewer");

    const res = await cancelGoal(
      goalLifecycleRequest(`/api/goals/${goalId}/cancel`, { reason: "viewer write attempt" }, hiveId),
      makeParams(goalId),
    );
    expect(res.status).toBe(403);

    const [goal] = await sql`
      SELECT status, archived_at FROM goals WHERE id = ${goalId}
    `;
    expect(goal.status).toBe("active");
    expect(goal.archived_at).toBeNull();
  });
});

describe("auth helper bearer path", () => {
  it("accepts a valid internal bearer token", async () => {
    const actualAuth = getActualAuthModule();
    process.env.VITEST = "false";
    process.env.INTERNAL_SERVICE_TOKEN = "test-internal-token";
    authState.authHeader = "Bearer test-internal-token";

    const result = await actualAuth.requireApiUser();
    expect("user" in result).toBe(true);
    if ("user" in result) {
      expect(result.user).toMatchObject({
        id: "internal-service-account",
        email: "service@hivewright.local",
        isSystemOwner: true,
      });
    }
  });

  it("rejects a wrong bearer token with 401", async () => {
    const actualAuth = getActualAuthModule();
    process.env.VITEST = "false";
    process.env.INTERNAL_SERVICE_TOKEN = "expected-token";
    authState.authHeader = "Bearer wrong-token";

    const response = await actualAuth.requireApiAuth();
    expect(response?.status).toBe(401);
  });

  it("rejects missing auth with 401", async () => {
    const actualAuth = getActualAuthModule();
    process.env.VITEST = "false";
    process.env.INTERNAL_SERVICE_TOKEN = "expected-token";

    const response = await actualAuth.requireApiAuth();
    expect(response?.status).toBe(401);
  });

  it("fails closed when INTERNAL_SERVICE_TOKEN is unset", async () => {
    const actualAuth = getActualAuthModule();
    process.env.VITEST = "false";
    delete process.env.INTERNAL_SERVICE_TOKEN;
    authState.authHeader = "Bearer expected-token";

    const response = await actualAuth.requireApiAuth();
    expect(response?.status).toBe(401);
  });

  it("accepts a valid internal bearer when the env token has surrounding whitespace", async () => {
    const actualAuth = getActualAuthModule();
    process.env.VITEST = "false";
    process.env.INTERNAL_SERVICE_TOKEN = "  expected-token  ";
    authState.authHeader = "Bearer expected-token";

    const result = await actualAuth.requireApiUser();
    expect("user" in result).toBe(true);
    if ("user" in result) {
      expect(result.user.id).toBe("internal-service-account");
    }
  });

  it("coexists with session auth and keeps bearer callers on the service-account identity", async () => {
    const actualAuth = getActualAuthModule();
    process.env.VITEST = "false";
    process.env.INTERNAL_SERVICE_TOKEN = "expected-token";
    authState.authHeader = "Bearer expected-token";
    authState.sessionUser = {
      id: "browser-user",
      email: "owner@example.com",
      name: "Owner",
    };

    const result = await actualAuth.requireApiUser();
    expect("user" in result).toBe(true);
    if ("user" in result) {
      expect(result.user.id).toBe("internal-service-account");
      expect(result.user.email).toBe("service@hivewright.local");
      expect(result.user.isSystemOwner).toBe(true);
    }
  });
});

describe("POST /api/tasks — role gate beyond session presence", () => {
  it("non-owner session is rejected with 403 even though it is authenticated", async () => {
    authState.isSystemOwner = false;

    const req = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        assignedTo: "dev-agent",
        title: PREFIX + "blocked task",
        brief: "should not be created",
      }),
    });
    const res = await createTask(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/forbidden/i);

    // No row should have been inserted.
    const rows = await sql`
      SELECT id FROM tasks WHERE title = ${PREFIX + "blocked task"}
    `;
    expect(rows.length).toBe(0);
  });

  it("system owner session creates the task (201)", async () => {
    const req = new Request("http://localhost/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        assignedTo: "dev-agent",
        title: PREFIX + "owner task",
        brief: "owner can create",
      }),
    });
    const res = await createTask(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.title).toBe(PREFIX + "owner task");
  });
});

describe.sequential("POST /api/work — internal service attribution guard", () => {
  it("preserves initiative-engine createdBy only for the internal service account path", async () => {
    authState.userId = "internal-service-account";

    const req = new Request("http://localhost/api/work", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        assignedTo: "dev-agent",
        input: PREFIX + "initiative task",
        createdBy: "initiative-engine",
      }),
    });

    const res = await createWork(req);
    expect(res.status).toBe(201);
    const body = await res.json();

    const [task] = await sql`
      SELECT created_by, assigned_to
      FROM tasks
      WHERE id = ${body.data.id}
    `;
    expect(task.created_by).toBe("initiative-engine");
    expect(task.assigned_to).toBe("dev-agent");
  });

  it("does not let a normal owner session spoof initiative-engine createdBy", async () => {
    const req = new Request("http://localhost/api/work", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        assignedTo: "dev-agent",
        input: PREFIX + "owner spoof attempt",
        createdBy: "initiative-engine",
      }),
    });

    const res = await createWork(req);
    expect(res.status).toBe(201);
    const body = await res.json();

    const [task] = await sql`
      SELECT created_by
      FROM tasks
      WHERE id = ${body.data.id}
    `;
    expect(task.created_by).toBe("owner");
  });

  it("keeps the goal/project hive-scope guard on the internal service initiative path", async () => {
    authState.userId = "internal-service-account";

    const [otherGoal] = await sql`
      INSERT INTO goals (hive_id, title, status)
      VALUES (${otherHiveId}, ${PREFIX + "cross-hive-goal"}, 'active')
      RETURNING id
    `;
    const [otherProject] = await sql`
      INSERT INTO projects (hive_id, slug, name, workspace_path)
      VALUES (${otherHiveId}, ${PREFIX + "cross-hive-project"}, 'Cross Hive Project', '/tmp/cross-hive-project')
      RETURNING id
    `;

    const goalRes = await createWork(new Request("http://localhost/api/work", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        assignedTo: "dev-agent",
        input: PREFIX + "cross-hive-goal attempt",
        goalId: otherGoal.id,
        createdBy: "initiative-engine",
      }),
    }));
    expect(goalRes.status).toBe(403);
    await expect(goalRes.json()).resolves.toMatchObject({
      error: "Forbidden: goal does not belong to hive",
    });

    const projectRes = await createWork(new Request("http://localhost/api/work", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        assignedTo: "dev-agent",
        input: PREFIX + "cross-hive-project attempt",
        projectId: otherProject.id,
        createdBy: "initiative-engine",
      }),
    }));
    expect(projectRes.status).toBe(403);
    await expect(projectRes.json()).resolves.toMatchObject({
      error: "Forbidden: project does not belong to hive",
    });
  });
});

describe("POST /api/credentials — privileged role guard", () => {
  it("non-owner session is rejected with 403", async () => {
    authState.isSystemOwner = false;
    process.env.ENCRYPTION_KEY ??= "auth-guards-credentials-key";

    const req = new Request("http://localhost/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        name: PREFIX + "blocked cred",
        key: PREFIX + "BLOCKED_KEY",
        value: "should-not-persist",
        rolesAllowed: [],
      }),
    });
    const res = await createCredential(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/forbidden/i);

    const rows = await sql`
      SELECT id FROM credentials WHERE key = ${PREFIX + "BLOCKED_KEY"}
    `;
    expect(rows.length).toBe(0);
  });

  it("system owner session creates the credential (201)", async () => {
    process.env.ENCRYPTION_KEY ??= "auth-guards-credentials-key";

    const req = new Request("http://localhost/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        name: PREFIX + "owner cred",
        key: PREFIX + "OWNER_KEY",
        value: "ok",
        rolesAllowed: [],
      }),
    });
    const res = await createCredential(req);
    expect(res.status).toBe(201);
  });
});

describe("DELETE /api/credentials/[id] — privileged role guard", () => {
  it("non-owner session is rejected with 403 and does not touch the row", async () => {
    process.env.ENCRYPTION_KEY ??= "auth-guards-credentials-key";

    // Seed as owner so there is a row to attempt deleting.
    const createReq = new Request("http://localhost/api/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hiveId,
        name: PREFIX + "delete-guard cred",
        key: PREFIX + "DELETE_GUARD_KEY",
        value: "keep-me",
        rolesAllowed: [],
      }),
    });
    const createRes = await createCredential(createReq);
    expect(createRes.status).toBe(201);
    const createdBody = await createRes.json();
    const credId: string = createdBody.data.id;

    // Now attempt deletion as a non-owner.
    authState.isSystemOwner = false;
    const delReq = new Request(`http://localhost/api/credentials/${credId}`, {
      method: "DELETE",
    });
    const res = await deleteCredential(delReq, {
      params: Promise.resolve({ id: credId }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/forbidden/i);

    const rows = await sql`SELECT id FROM credentials WHERE id = ${credId}`;
    expect(rows.length).toBe(1);
  });
});

describe("POST /api/dispatcher/restart — privileged role guard", () => {
  it("non-owner session is rejected with 403 and does not exec systemctl", async () => {
    authState.isSystemOwner = false;
    // A bogus SYSTEMCTL_BIN would fail loudly if the handler ever reached
    // the spawn call — the 403 gate should short-circuit before that.
    process.env.SYSTEMCTL_BIN = "/nonexistent/systemctl-should-not-run";

    const res = await restartDispatcher(
      new Request("http://localhost/api/dispatcher/restart", { method: "POST" }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/forbidden/i);

    delete process.env.SYSTEMCTL_BIN;
  });
});

describe("GET /api/attachments/[id]/download — ownership guard", () => {
  const DL_SLUG = "auth-guards-att-dl";
  const DL_DIR = path.join(
    "/home/example/hives",
    DL_SLUG,
    "task-attachments",
    "task-uuid",
  );

  async function seedAttachment(): Promise<{ attachmentId: string; filePath: string }> {
    const [biz] = await sql`
      INSERT INTO hives (slug, name, type, workspace_path)
      VALUES (${DL_SLUG}, 'Auth Guards DL', 'digital', '/tmp')
      RETURNING id
    `;
    const [task] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, qa_required)
      VALUES (${biz.id}, 'dev-agent', 'owner', 't', 'b', false)
      RETURNING id
    `;
    if (fs.existsSync(DL_DIR)) fs.rmSync(DL_DIR, { recursive: true, force: true });
    fs.mkdirSync(DL_DIR, { recursive: true });
    const filePath = path.join(DL_DIR, "fixture.bin");
    fs.writeFileSync(filePath, Buffer.from("secret-bytes"));
    const [att] = await sql`
      INSERT INTO task_attachments (task_id, filename, storage_path, mime_type, size_bytes)
      VALUES (${task.id}, 'fixture.bin', ${filePath}, 'application/octet-stream', 12)
      RETURNING id
    `;
    return { attachmentId: att.id as string, filePath };
  }

  it("non-owner session is rejected with 403 and bytes are not served", async () => {
    authState.isSystemOwner = false;
    const { attachmentId } = await seedAttachment();

    const res = await downloadAttachment(
      new Request(`http://localhost/api/attachments/${attachmentId}/download`),
      makeParams(attachmentId),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/forbidden/i);
    // The response must not leak the file body.
    expect(res.headers.get("content-type") ?? "").not.toMatch(/octet-stream/);
  });

  it("system owner session downloads the attachment (200)", async () => {
    const { attachmentId } = await seedAttachment();

    const res = await downloadAttachment(
      new Request(`http://localhost/api/attachments/${attachmentId}/download`),
      makeParams(attachmentId),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.toString("utf8")).toBe("secret-bytes");

    fs.rmSync(`/home/example/hives/${DL_SLUG}`, { recursive: true, force: true });
  });
});
