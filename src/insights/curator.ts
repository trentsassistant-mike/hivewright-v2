import type { Sql } from "postgres";
import { promoteInsightToInstruction } from "../standing-instructions/manager";

/**
 * Insight Curator: deterministic post-synthesis pass that classifies every
 * `status='new'` insight into one of four terminal dispositions so the owner
 * never has to babysit the inbox.
 *
 *   promote     → high-confidence, multi-department → standing_instructions
 *   escalate    → high-confidence risk              → decisions (Tier 3)
 *   dismiss     → low-confidence / low-signal       → status='dismissed'
 *   acknowledge → middle bucket, kept for reference → status='acknowledged'
 *
 * Thresholds live as module constants so they're easy to tune. Keep this
 * deterministic — the owner explicitly wants autonomy without LLM drift, and
 * synthesis already used a model to produce the insight.
 */

export type CuratorKind = "promote" | "escalate" | "dismiss" | "acknowledge";

export interface CuratorDisposition {
  kind: CuratorKind;
  reason: string;
}

export interface CandidateInsight {
  id: string;
  hiveId: string;
  content: string;
  connectionType: string;
  confidence: number;
  affectedDepartments: string[];
  priority: string;
}

export const ESCALATE_RISK_CONFIDENCE = 0.9;
export const PROMOTE_CONFIDENCE = 0.85;
export const PROMOTE_MIN_DEPARTMENTS = 2;
export const DISMISS_BELOW = 0.6;

export function classifyInsight(i: CandidateInsight): CuratorDisposition {
  const confPct = (i.confidence * 100).toFixed(0);

  if (i.connectionType === "risk" && i.confidence >= ESCALATE_RISK_CONFIDENCE) {
    return {
      kind: "escalate",
      reason: `Risk at ${confPct}% confidence — owner decides whether to act, dismiss, or promote.`,
    };
  }
  if (
    i.confidence >= PROMOTE_CONFIDENCE &&
    i.affectedDepartments.length >= PROMOTE_MIN_DEPARTMENTS
  ) {
    return {
      kind: "promote",
      reason: `Confidence ${confPct}% across ${i.affectedDepartments.length} departments — auto-promoted to a standing instruction.`,
    };
  }
  if (i.confidence < DISMISS_BELOW) {
    return {
      kind: "dismiss",
      reason: `Confidence ${confPct}% below the ${(DISMISS_BELOW * 100).toFixed(0)}% threshold — dismissed as low-signal.`,
    };
  }
  return {
    kind: "acknowledge",
    reason: `${i.connectionType} at ${confPct}% confidence — kept for reference, no action required.`,
  };
}

export async function findUncuratedInsights(
  sql: Sql,
  hiveId: string,
): Promise<CandidateInsight[]> {
  const rows = await sql`
    SELECT id, hive_id, content, connection_type, confidence,
           affected_departments, priority
    FROM insights
    WHERE hive_id = ${hiveId} AND status = 'new'
    ORDER BY confidence DESC, created_at ASC
  `;
  return rows.map((r) => ({
    id: r.id as string,
    hiveId: r.hive_id as string,
    content: r.content as string,
    connectionType: r.connection_type as string,
    confidence: r.confidence as number,
    affectedDepartments: (r.affected_departments ?? []) as string[],
    priority: r.priority as string,
  }));
}

export interface CuratorRunResult {
  promoted: number;
  escalated: number;
  dismissed: number;
  acknowledged: number;
}

const COUNTER_BY_KIND: Record<CuratorKind, keyof CuratorRunResult> = {
  promote: "promoted",
  escalate: "escalated",
  dismiss: "dismissed",
  acknowledge: "acknowledged",
};

export async function applyDisposition(
  sql: Sql,
  insight: CandidateInsight,
  disposition: CuratorDisposition,
): Promise<void> {
  switch (disposition.kind) {
    case "promote": {
      await promoteInsightToInstruction(sql, insight.id);
      // promoteInsightToInstruction sets status='actioned'; we layer on the
      // curator's reason + timestamp without touching status.
      await sql`
        UPDATE insights
        SET curator_reason = ${disposition.reason},
            curated_at = NOW(),
            updated_at = NOW()
        WHERE id = ${insight.id}
      `;
      return;
    }
    case "escalate": {
      const truncated =
        insight.content.length > 120
          ? `${insight.content.slice(0, 120)}…`
          : insight.content;
      const departments = insight.affectedDepartments.join(", ") || "the system";
      const [decision] = await sql`
        INSERT INTO decisions (hive_id, title, context, recommendation, options, priority, status)
        VALUES (
          ${insight.hiveId},
          ${`Risk insight needs review: ${truncated}`},
          ${
            `The synthesis engine flagged a risk insight (${(insight.confidence * 100).toFixed(0)}% confidence) ` +
            `affecting ${departments}.\n\nFull insight:\n${insight.content}`
          },
          'Review the insight and either dismiss it, promote it to a standing instruction, or take direct action.',
          ${sql.json([
            { label: "Promote to standing instruction", action: "promote_insight" },
            { label: "Dismiss as not actionable", action: "dismiss_insight" },
          ])},
          ${insight.priority === "high" ? "high" : "normal"},
          'ea_review'
        )
        RETURNING id
      `;
      await sql`
        UPDATE insights
        SET status = 'escalated',
            curator_reason = ${disposition.reason},
            decision_id = ${decision.id as string},
            curated_at = NOW(),
            updated_at = NOW()
        WHERE id = ${insight.id}
      `;
      return;
    }
    case "dismiss": {
      await sql`
        UPDATE insights
        SET status = 'dismissed',
            curator_reason = ${disposition.reason},
            curated_at = NOW(),
            updated_at = NOW()
        WHERE id = ${insight.id}
      `;
      return;
    }
    case "acknowledge": {
      await sql`
        UPDATE insights
        SET status = 'acknowledged',
            curator_reason = ${disposition.reason},
            curated_at = NOW(),
            updated_at = NOW()
        WHERE id = ${insight.id}
      `;
      return;
    }
  }
}

export async function runInsightCurator(
  sql: Sql,
  hiveId: string,
): Promise<CuratorRunResult> {
  const candidates = await findUncuratedInsights(sql, hiveId);
  const result: CuratorRunResult = {
    promoted: 0,
    escalated: 0,
    dismissed: 0,
    acknowledged: 0,
  };
  for (const insight of candidates) {
    const disposition = classifyInsight(insight);
    try {
      await applyDisposition(sql, insight, disposition);
      result[COUNTER_BY_KIND[disposition.kind]]++;
    } catch (err) {
      console.error(
        `[curator] failed to apply ${disposition.kind} to insight ${insight.id}:`,
        err,
      );
    }
  }
  return result;
}
