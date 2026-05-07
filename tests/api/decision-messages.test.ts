import { describe, it, expect, beforeEach } from "vitest";
import { GET as getMessages, POST as postMessage } from "@/app/api/decisions/[id]/messages/route";
import { POST as respondToDecision } from "@/app/api/decisions/[id]/respond/route";
import {
  findPendingOwnerDecisionComments,
  mirrorOwnerDecisionCommentToGoalComment,
} from "@/decisions/owner-comment-wake";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const PREFIX = "t7-dm-";
let hiveId: string;
let decisionId: string;

beforeEach(async () => {
  await truncateAll(sql);

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type)
    VALUES (${PREFIX + "biz"}, 'T7 Decision Messages Test', 'digital')
    RETURNING id
  `;
  hiveId = biz.id;

  const [dec] = await sql`
    INSERT INTO decisions (hive_id, title, context, priority, status)
    VALUES (${hiveId}, 'Thread test decision', 'Need input on approach', 'normal', 'pending')
    RETURNING id
  `;
  decisionId = dec.id;
});

describe("Decision Messages API", () => {
  it("POST /api/decisions/[id]/messages — creates a message (201)", async () => {
    const req = new Request(
      `http://localhost/api/decisions/${decisionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "What about option B?" }),
      },
    );

    const res = await postMessage(req, {
      params: Promise.resolve({ id: decisionId }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.content).toBe("What about option B?");
    expect(body.data.sender).toBe("owner");
    expect(body.data.decisionId).toBe(decisionId);
    expect(body.data.id).toBeDefined();
    expect(body.data.createdAt).toBeDefined();
  });

  it("POST /api/decisions/[id]/messages — returns 400 without content", async () => {
    const req = new Request(
      `http://localhost/api/decisions/${decisionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: "owner" }),
      },
    );

    const res = await postMessage(req, {
      params: Promise.resolve({ id: decisionId }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/content/i);
  });

  it("POST /api/decisions/[id]/messages — accepts custom sender", async () => {
    const req = new Request(
      `http://localhost/api/decisions/${decisionId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Supervisor note", sender: "goal-supervisor" }),
      },
    );

    const res = await postMessage(req, {
      params: Promise.resolve({ id: decisionId }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.sender).toBe("goal-supervisor");
  });

  it("GET /api/decisions/[id]/messages — returns messages ordered by created_at ASC", async () => {
    // Seed two messages so we have something to order
    await postMessage(
      new Request(`http://localhost/api/decisions/${decisionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "First message" }),
      }),
      { params: Promise.resolve({ id: decisionId }) },
    );
    await postMessage(
      new Request(`http://localhost/api/decisions/${decisionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Second message" }),
      }),
      { params: Promise.resolve({ id: decisionId }) },
    );

    const req = new Request(
      `http://localhost/api/decisions/${decisionId}/messages`,
    );

    const res = await getMessages(req, {
      params: Promise.resolve({ id: decisionId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(2);

    // Verify ascending order
    for (let i = 1; i < body.data.length; i++) {
      const prev = new Date(body.data[i - 1].createdAt).getTime();
      const curr = new Date(body.data[i].createdAt).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });

  it("GET /api/decisions/[id]/messages — returns empty array for decision with no messages", async () => {
    // Create a separate decision with no messages
    const [dec2] = await sql`
      INSERT INTO decisions (hive_id, title, context, priority, status)
      VALUES (${hiveId}, 'No messages decision', 'Empty thread', 'normal', 'pending')
      RETURNING id
    `;

    const req = new Request(
      `http://localhost/api/decisions/${dec2.id}/messages`,
    );

    const res = await getMessages(req, {
      params: Promise.resolve({ id: dec2.id }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  it("POST owner message on a goal decision mirrors once into goal_comments for supervisor wake", async () => {
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${hiveId}, 'Decision comment wake goal', 'active', 'supervisor-session-1')
      RETURNING id
    `;
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, goal_id, title, context, priority, status)
      VALUES (${hiveId}, ${goal.id}, 'Goal-linked decision', 'Need owner input', 'normal', 'pending')
      RETURNING id
    `;

    const res = await postMessage(
      new Request(`http://localhost/api/decisions/${decision.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Use option 3 with GCA login" }),
      }),
      { params: Promise.resolve({ id: decision.id }) },
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    const [message] = await sql<{ supervisor_woken_at: Date | null }[]>`
      SELECT supervisor_woken_at FROM decision_messages WHERE id = ${body.data.id}
    `;
    expect(message.supervisor_woken_at).not.toBeNull();

    const goalComments = await sql<{ body: string; created_by: string }[]>`
      SELECT body, created_by FROM goal_comments WHERE goal_id = ${goal.id}
    `;
    expect(goalComments).toHaveLength(1);
    expect(goalComments[0].created_by).toBe("owner");
    expect(goalComments[0].body).toContain("Goal-linked decision");
    expect(goalComments[0].body).toContain("Use option 3 with GCA login");

    const second = await mirrorOwnerDecisionCommentToGoalComment(sql, body.data.id);
    expect(second).toMatchObject({ status: "skipped", reason: "already_woken" });
    const afterSecond = await sql`SELECT id FROM goal_comments WHERE goal_id = ${goal.id}`;
    expect(afterSecond).toHaveLength(1);
  });

  it("does not wake supervisors for non-owner decision messages", async () => {
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${hiveId}, 'Decision system-comment goal', 'active', 'supervisor-session-2')
      RETURNING id
    `;
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, goal_id, title, context, priority, status)
      VALUES (${hiveId}, ${goal.id}, 'System-linked decision', 'Internal note', 'normal', 'pending')
      RETURNING id
    `;

    const res = await postMessage(
      new Request(`http://localhost/api/decisions/${decision.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Supervisor note", sender: "goal-supervisor" }),
      }),
      { params: Promise.resolve({ id: decision.id }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();

    const result = await mirrorOwnerDecisionCommentToGoalComment(sql, body.data.id);
    expect(result).toMatchObject({ status: "skipped", reason: "non_owner_sender" });
    const goalComments = await sql`SELECT id FROM goal_comments WHERE goal_id = ${goal.id}`;
    expect(goalComments).toHaveLength(0);
  });

  it("fallback polling finds missed owner comments attached to parked supervised goals", async () => {
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${hiveId}, 'Decision fallback wake goal', 'active', 'supervisor-session-3')
      RETURNING id
    `;
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, goal_id, title, context, priority, status)
      VALUES (${hiveId}, ${goal.id}, 'Fallback decision', 'Need owner input', 'normal', 'pending')
      RETURNING id
    `;
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO decision_messages (decision_id, sender, content)
      VALUES (${decision.id}, 'owner', 'Missed by live notification')
      RETURNING id
    `;

    const pending = await findPendingOwnerDecisionComments(sql);
    expect(pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId: message.id, decisionId: decision.id, goalId: goal.id }),
      ]),
    );

    const mirrored = await mirrorOwnerDecisionCommentToGoalComment(sql, message.id);
    expect(mirrored).toMatchObject({ status: "mirrored", goalId: goal.id });
    const after = await findPendingOwnerDecisionComments(sql);
    expect(after.some((item) => item.messageId === message.id)).toBe(false);
  });

  it("mirrors an owner decision message only once when wake paths race", async () => {
    const [goal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, status, session_id)
      VALUES (${hiveId}, 'Decision wake race goal', 'active', 'supervisor-session-race')
      RETURNING id
    `;
    const [decision] = await sql<{ id: string }[]>`
      INSERT INTO decisions (hive_id, goal_id, title, context, priority, status)
      VALUES (${hiveId}, ${goal.id}, 'Race decision', 'Need owner input', 'normal', 'pending')
      RETURNING id
    `;
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO decision_messages (decision_id, sender, content)
      VALUES (${decision.id}, 'owner', 'Wake exactly once')
      RETURNING id
    `;

    const results = await Promise.all([
      mirrorOwnerDecisionCommentToGoalComment(sql, message.id),
      mirrorOwnerDecisionCommentToGoalComment(sql, message.id),
    ]);

    expect(results.filter((result) => result.status === "mirrored")).toHaveLength(1);
    expect(results.filter((result) => result.status === "skipped")).toHaveLength(1);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "skipped", reason: "already_woken" }),
      ]),
    );
    const goalComments = await sql`SELECT id FROM goal_comments WHERE goal_id = ${goal.id}`;
    expect(goalComments).toHaveLength(1);
  });
});

describe("Decision Respond — discussed vs resolved", () => {
  let pendingDecisionId: string;

  beforeEach(async () => {
    const [dec] = await sql`
      INSERT INTO decisions (hive_id, title, context, priority, status)
      VALUES (${hiveId}, 'Discussion test', 'Should we pivot?', 'normal', 'pending')
      RETURNING id
    `;
    pendingDecisionId = dec.id;
  });

  it("POST respond with 'discussed' keeps decision pending and creates message", async () => {
    const req = new Request(
      `http://localhost/api/decisions/${pendingDecisionId}/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response: "discussed",
          comment: "Let me think about this more",
        }),
      },
    );

    const res = await respondToDecision(req, {
      params: Promise.resolve({ id: pendingDecisionId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("pending");
    expect(body.data.resolvedAt).toBeNull();
    expect(body.data.ownerResponse).toBe("discussed: Let me think about this more");

    // Verify a message was inserted
    const messages = await sql`
      SELECT * FROM decision_messages WHERE decision_id = ${pendingDecisionId}
    `;
    expect(messages.length).toBe(1);
    expect(messages[0].sender).toBe("owner");
    expect(messages[0].content).toBe("Let me think about this more");
  });

  it("POST respond with 'approved' resolves the decision", async () => {
    const req = new Request(
      `http://localhost/api/decisions/${pendingDecisionId}/respond`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response: "approved",
          comment: "Go ahead",
        }),
      },
    );

    const res = await respondToDecision(req, {
      params: Promise.resolve({ id: pendingDecisionId }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("resolved");
    expect(body.data.resolvedAt).not.toBeNull();
    expect(body.data.ownerResponse).toBe("approved: Go ahead");
  });
});
