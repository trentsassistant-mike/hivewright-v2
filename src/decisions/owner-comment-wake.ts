import type { Sql } from "postgres";

export type DecisionOwnerCommentWakeResult =
  | {
      status: "mirrored";
      decisionMessageId: string;
      goalCommentId: string;
      goalId: string;
    }
  | {
      status: "skipped";
      decisionMessageId: string;
      reason:
        | "not_found"
        | "non_owner_sender"
        | "no_goal"
        | "goal_not_active"
        | "no_supervisor_session"
        | "already_woken";
    };

export type PendingDecisionOwnerComment = {
  messageId: string;
  decisionId: string;
  goalId: string;
};

function isOwnerSender(sender: string | null | undefined): boolean {
  // Decision message authorship is historically a free-form `sender` string.
  // Route-created messages default missing sender to "owner"; once persisted,
  // only explicit sender="owner" wakes supervisors. This avoids waking on
  // obvious EA/system/agent comments while preserving legacy owner comments.
  return sender === "owner";
}

export async function mirrorOwnerDecisionCommentToGoalComment(
  sql: Sql,
  decisionMessageId: string,
): Promise<DecisionOwnerCommentWakeResult> {
  return sql.begin(async (tx) => {
    const [row] = await tx<
      {
        message_id: string;
        decision_id: string;
        sender: string;
        content: string;
        supervisor_woken_at: Date | null;
        decision_title: string;
        goal_id: string | null;
        goal_status: string | null;
        session_id: string | null;
      }[]
    >`
      SELECT
        dm.id AS message_id,
        d.id AS decision_id,
        dm.sender,
        dm.content,
        dm.supervisor_woken_at,
        d.title AS decision_title,
        d.goal_id,
        g.status AS goal_status,
        g.session_id
      FROM decision_messages dm
      JOIN decisions d ON d.id = dm.decision_id
      LEFT JOIN goals g ON g.id = d.goal_id
      WHERE dm.id = ${decisionMessageId}
    `;

    if (!row) return { status: "skipped", decisionMessageId, reason: "not_found" };
    if (!isOwnerSender(row.sender)) {
      return { status: "skipped", decisionMessageId, reason: "non_owner_sender" };
    }
    if (!row.goal_id) return { status: "skipped", decisionMessageId, reason: "no_goal" };
    if (row.goal_status !== "active") {
      return { status: "skipped", decisionMessageId, reason: "goal_not_active" };
    }
    if (!row.session_id) {
      return { status: "skipped", decisionMessageId, reason: "no_supervisor_session" };
    }

    // Claim the message before mirroring. Route-time handling and the dispatcher
    // LISTEN/fallback paths can race for the same decision message; this guarded
    // update is the idempotency lock that makes only one caller insert a wake
    // comment.
    const [claimed] = await tx<{ id: string }[]>`
      UPDATE decision_messages
      SET supervisor_woken_at = NOW()
      WHERE id = ${decisionMessageId}
        AND supervisor_woken_at IS NULL
      RETURNING id
    `;
    if (!claimed) {
      return { status: "skipped", decisionMessageId, reason: "already_woken" };
    }

    const body = [
      `Owner commented on decision "${row.decision_title}" (${row.decision_id}).`,
      "",
      row.content,
    ].join("\n");

    const [goalComment] = await tx<{ id: string }[]>`
      INSERT INTO goal_comments (goal_id, body, created_by)
      VALUES (${row.goal_id}, ${body}, 'owner')
      RETURNING id
    `;

    return {
      status: "mirrored",
      decisionMessageId,
      goalCommentId: goalComment.id,
      goalId: row.goal_id,
    };
  });
}

export async function findPendingOwnerDecisionComments(
  sql: Sql,
  limit = 25,
): Promise<PendingDecisionOwnerComment[]> {
  const rows = await sql<
    { message_id: string; decision_id: string; goal_id: string }[]
  >`
    SELECT
      dm.id AS message_id,
      d.id AS decision_id,
      d.goal_id
    FROM decision_messages dm
    JOIN decisions d ON d.id = dm.decision_id
    JOIN goals g ON g.id = d.goal_id
    WHERE dm.sender = 'owner'
      AND dm.supervisor_woken_at IS NULL
      AND d.goal_id IS NOT NULL
      AND g.status = 'active'
      AND g.session_id IS NOT NULL
    ORDER BY dm.created_at ASC
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    messageId: row.message_id,
    decisionId: row.decision_id,
    goalId: row.goal_id,
  }));
}
