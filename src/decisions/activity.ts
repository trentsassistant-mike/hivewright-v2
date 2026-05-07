import type { Sql } from "postgres";

export type DecisionActivityActor =
  | "owner"
  | "system mirror"
  | "supervisor"
  | "ea-resolver"
  | "system";

export type DecisionActivityEntry = {
  id: string;
  timestamp: Date;
  actor: DecisionActivityActor;
  summary: string;
  sourceType: "decision_message" | "goal_comment" | "decision" | "descendant_decision";
  sourceId: string;
};

type DecisionActivityDecisionRow = {
  id: string;
  goal_id: string | null;
  status: string;
  owner_response: string | null;
  ea_attempts: number;
  ea_reasoning: string | null;
  ea_decided_at: Date | null;
  resolved_at: Date | null;
  resolved_by: string | null;
  created_at: Date;
};

function firstLine(value: string, maxLength = 220): string {
  const compact = value
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}...`;
}

function actorForDecisionMessage(sender: string): DecisionActivityActor {
  if (sender === "owner") return "owner";
  if (sender === "goal-supervisor") return "supervisor";
  if (sender === "ea-resolver") return "ea-resolver";
  return "system";
}

function actorForGoalComment(createdBy: string): DecisionActivityActor {
  if (createdBy === "owner") return "system mirror";
  if (/supervisor/i.test(createdBy)) return "supervisor";
  if (/ea/i.test(createdBy)) return "ea-resolver";
  return "supervisor";
}

export async function getDecisionActivity(
  sql: Sql,
  decisionId: string,
): Promise<DecisionActivityEntry[]> {
  const [decision] = await sql<DecisionActivityDecisionRow[]>`
    SELECT id, goal_id, status, owner_response, ea_attempts, ea_reasoning,
           ea_decided_at, resolved_at, resolved_by, created_at
    FROM decisions
    WHERE id = ${decisionId}
  `;
  if (!decision) return [];

  const entries: DecisionActivityEntry[] = [];

  const messages = await sql<
    {
      id: string;
      sender: string;
      content: string;
      created_at: Date;
      supervisor_woken_at: Date | null;
    }[]
  >`
    SELECT id, sender, content, created_at, supervisor_woken_at
    FROM decision_messages
    WHERE decision_id = ${decisionId}
    ORDER BY created_at ASC
  `;

  for (const message of messages) {
    entries.push({
      id: `decision-message:${message.id}`,
      timestamp: message.created_at,
      actor: actorForDecisionMessage(message.sender),
      summary: firstLine(message.content),
      sourceType: "decision_message",
      sourceId: message.id,
    });

    if (message.supervisor_woken_at) {
      entries.push({
        id: `decision-message:${message.id}:supervisor-wake`,
        timestamp: message.supervisor_woken_at,
        actor: "system mirror",
        summary: "Mirrored owner discussion to the linked goal and woke the supervisor.",
        sourceType: "decision_message",
        sourceId: message.id,
      });
    }
  }

  if (decision.goal_id) {
    const goalComments = await sql<
      { id: string; body: string; created_by: string; created_at: Date }[]
    >`
      SELECT id, body, created_by, created_at
      FROM goal_comments
      WHERE goal_id = ${decision.goal_id}
      ORDER BY created_at ASC
    `;

    for (const comment of goalComments) {
      entries.push({
        id: `goal-comment:${comment.id}`,
        timestamp: comment.created_at,
        actor: actorForGoalComment(comment.created_by),
        summary: firstLine(comment.body),
        sourceType: "goal_comment",
        sourceId: comment.id,
      });
    }
  }

  if (decision.ea_decided_at) {
    const summary = decision.owner_response?.trim()
      ? `EA recorded outcome: ${firstLine(decision.owner_response)}`
      : decision.ea_reasoning?.trim()
        ? `EA assessed the decision: ${firstLine(decision.ea_reasoning)}`
        : `EA assessed the decision after ${decision.ea_attempts} attempt(s).`;
    entries.push({
      id: `decision:${decision.id}:ea`,
      timestamp: decision.ea_decided_at,
      actor: "ea-resolver",
      summary,
      sourceType: "decision",
      sourceId: decision.id,
    });
  }

  if (decision.resolved_at && decision.resolved_by) {
    entries.push({
      id: `decision:${decision.id}:resolved`,
      timestamp: decision.resolved_at,
      actor: decision.resolved_by === "ea-resolver" ? "ea-resolver" : "system",
      summary: `Decision resolved by ${decision.resolved_by}.`,
      sourceType: "decision",
      sourceId: decision.id,
    });
  }

  if (decision.goal_id) {
    const anchor = decision.ea_decided_at ?? decision.created_at;
    const descendants = await sql<
      {
        id: string;
        title: string;
        owner_response: string | null;
        ea_decided_at: Date | null;
        resolved_at: Date | null;
        resolved_by: string | null;
      }[]
    >`
      SELECT id, title, owner_response, ea_decided_at, resolved_at, resolved_by
      FROM decisions
      WHERE id <> ${decisionId}
        AND goal_id = ${decision.goal_id}
        AND (
          ea_decided_at BETWEEN ${anchor}::timestamp - INTERVAL '30 minutes'
                            AND ${anchor}::timestamp + INTERVAL '30 minutes'
          OR resolved_at BETWEEN ${anchor}::timestamp - INTERVAL '30 minutes'
                         AND ${anchor}::timestamp + INTERVAL '30 minutes'
        )
        AND (
          resolved_by = 'ea-resolver'
          OR owner_response ILIKE 'ea-decided:%'
          OR ea_decided_at IS NOT NULL
        )
      ORDER BY COALESCE(ea_decided_at, resolved_at) ASC
      LIMIT 10
    `;

    for (const descendant of descendants) {
      const timestamp = descendant.ea_decided_at ?? descendant.resolved_at;
      if (!timestamp) continue;
      entries.push({
        id: `descendant-decision:${descendant.id}`,
        timestamp,
        actor: "ea-resolver",
        summary: descendant.owner_response?.trim()
          ? `Related decision "${descendant.title}" resolved: ${firstLine(descendant.owner_response)}`
          : `Related decision "${descendant.title}" was handled by the EA.`,
        sourceType: "descendant_decision",
        sourceId: descendant.id,
      });
    }
  }

  return entries.sort((a, b) => {
    const delta = a.timestamp.getTime() - b.timestamp.getTime();
    return delta === 0 ? a.id.localeCompare(b.id) : delta;
  });
}
