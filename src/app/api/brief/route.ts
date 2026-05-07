import type { Sql } from "postgres";
import { sql as appSql } from "../_lib/db";
import { jsonError, jsonOk } from "../_lib/responses";
import {
  fetchLatestSupervisorReport,
  summarizeSupervisorReport,
} from "../supervisor-reports/queries";
import {
  fetchInitiativeRunSummary,
  fetchLatestInitiativeRun,
  summarizeInitiativeRun,
} from "../initiative-runs/queries";
import { requireApiUser } from "../_lib/auth";
import { canAccessHive } from "@/auth/users";
import { calculateCostCents } from "@/adapters/provider-config";
import { getHiveCreationPause } from "@/operations/creation-pause";
import { getHiveResumeReadiness } from "@/hives/resume-readiness";

/**
 * Owner Brief — the synthesis surface that makes HiveWright feel like it's
 * running itself. One call, everything the owner needs to know right now:
 * what's waiting on them, what's progressing, what's stalled, what's new.
 *
 * Also doubles as the payload behind the daily Discord digest.
 */

type GoalHealth = "on_track" | "waiting_on_owner" | "stalled" | "at_risk" | "achieved";

interface TaskCostRow {
  costCents: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;
  modelUsed: string | null;
}

function effectiveCents(row: TaskCostRow): number {
  if (row.costCents && row.costCents > 0) return row.costCents;
  const tin = row.tokensInput ?? 0;
  const tout = row.tokensOutput ?? 0;
  if (tin === 0 && tout === 0) return 0;
  return calculateCostCents(row.modelUsed ?? "openai-codex/gpt-5.4", tin, tout);
}

async function getBrief(request: Request, db: Sql) {
  try {
    const url = new URL(request.url);
    const hiveId = url.searchParams.get("hiveId");
    if (!hiveId) return jsonError("hiveId is required", 400);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(hiveId)) {
      return jsonError("hiveId must be a valid UUID", 400);
    }

    const authz = await requireApiUser();
    if ("response" in authz) return authz.response;
    const { user } = authz;
    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(db, user.id, hiveId);
      if (!hasAccess) {
        return jsonError("Forbidden: caller cannot access this hive", 403);
      }
    }

    // Pending decisions (urgent first, freshest within priority). Limit 10 so
    // a runaway never floods the brief.
    const decisionRows = await db`
      SELECT id, title, priority, context, created_at,
             EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 AS age_hours
      FROM decisions
      WHERE hive_id = ${hiveId}::uuid
        AND status = 'pending'
        AND kind = 'decision'
        AND is_qa_fixture = false
      ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END, created_at ASC
      LIMIT 10
    `;

    const [qualityFeedbackRow] = await db<{ pending_quality_feedback: number }[]>`
      SELECT COUNT(*)::int AS pending_quality_feedback
      FROM decisions
      WHERE hive_id = ${hiveId}::uuid
        AND status = 'pending'
        AND kind = 'task_quality_feedback'
        AND COALESCE(options #>> '{lane}', 'owner') = 'owner'
        AND is_qa_fixture = false
    `;

    // Dashboard goals with progress + last activity. Home should hide only
    // achieved goals; other non-archived goal states still belong here.
    const goalRows = await db`
      WITH task_counts AS (
        SELECT goal_id,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status = 'completed') AS done,
               COUNT(*) FILTER (WHERE status IN ('failed', 'unresolvable')) AS failed,
               COUNT(*) FILTER (WHERE status IN ('active', 'pending', 'blocked', 'in_review')) AS open,
               MAX(updated_at) AS last_activity
          FROM tasks
         WHERE goal_id IS NOT NULL
         GROUP BY goal_id
      )
      SELECT g.id, g.title, g.status, g.budget_cents, g.spent_cents,
             g.created_at, g.updated_at,
             COALESCE(tc.total, 0) AS total,
             COALESCE(tc.done, 0) AS done,
             COALESCE(tc.failed, 0) AS failed,
             COALESCE(tc.open, 0) AS open,
             tc.last_activity,
             EXTRACT(EPOCH FROM (NOW() - COALESCE(tc.last_activity, g.updated_at))) / 3600 AS idle_hours,
             (SELECT COUNT(*) FROM decisions d WHERE d.goal_id = g.id AND d.status = 'pending' AND d.kind = 'decision' AND d.is_qa_fixture = false) AS pending_decisions
      FROM goals g
      LEFT JOIN task_counts tc ON tc.goal_id = g.id
      WHERE g.hive_id = ${hiveId}::uuid
        AND g.archived_at IS NULL
        AND g.status <> 'achieved'
      ORDER BY g.updated_at DESC
    `;

    // Recent completions (24 h window). The dashboard shows these as "done
    // while you were away". Exclude internal routing, QA re-reviews, and
    // quiet hive-supervisor heartbeats — watchdog rows whose linked
    // supervisor_reports applied no non-noop actions carry no operator-
    // visible signal and just clog the feed (the Supervisor findings panel
    // already surfaces counts). Heartbeats that DID apply non-noop actions
    // stay visible.
    const recentCompletionRows = await db`
      SELECT t.id, t.title, t.assigned_to, t.updated_at
      FROM tasks t
      WHERE t.hive_id = ${hiveId}::uuid
        AND t.status = 'completed'
        AND t.updated_at > NOW() - INTERVAL '24 hours'
        AND t.title NOT LIKE 'Result:%'
        AND t.title NOT LIKE 'ESCALATION:%'
        AND NOT (
          t.assigned_to = 'hive-supervisor'
          AND NOT EXISTS (
            SELECT 1 FROM supervisor_reports sr
            CROSS JOIN LATERAL jsonb_array_elements(
              COALESCE(sr.action_outcomes, '[]'::jsonb)
            ) AS outcome(value)
            WHERE sr.agent_task_id = t.id
              AND outcome.value->>'status' = 'applied'
              AND COALESCE(outcome.value->'action'->>'kind', '') <> 'noop'
          )
        )
      ORDER BY t.updated_at DESC
      LIMIT 8
    `;

    // New / unreviewed insights — the synthesis engine's output that hasn't
    // been seen yet.
    const newInsightRows = await db`
      SELECT id, content, priority, connection_type, confidence, created_at
      FROM insights
      WHERE hive_id = ${hiveId}::uuid AND status = 'new'
      ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC
      LIMIT 5
    `;

    // Cost windows — compute cents from tokens for any row where stored
    // cost_cents is 0/null but tokens are known. Timestamp by
    // COALESCE(started_at, updated_at) since started_at isn't reliably
    // populated on every historical row.
    const costRows = (await db`
      SELECT cost_cents, tokens_input, tokens_output, model_used,
             COALESCE(started_at, updated_at) AS ts
      FROM tasks
      WHERE hive_id = ${hiveId}::uuid
        AND COALESCE(started_at, updated_at) > NOW() - INTERVAL '30 days'
    `) as unknown as Array<{
      cost_cents: number | null;
      tokens_input: number | null;
      tokens_output: number | null;
      model_used: string | null;
      ts: Date;
    }>;
    let today = 0, week = 0, month = 0;
    const nowMs = Date.now();
    for (const r of costRows) {
      const cents = effectiveCents({
        costCents: r.cost_cents,
        tokensInput: r.tokens_input,
        tokensOutput: r.tokens_output,
        modelUsed: r.model_used,
      });
      if (cents === 0) continue;
      const ageMs = nowMs - new Date(r.ts).getTime();
      if (ageMs <= 24 * 3600_000) today += cents;
      if (ageMs <= 7 * 24 * 3600_000) week += cents;
      month += cents;
    }

    // Supervisor heartbeat — latest report row for this hive. null when
    // the hive has never had a supervisor run yet. Kept deliberately slim
    // (counts only, no findings detail) so the brief stays cheap; the
    // full payload lives at /api/supervisor-reports for the panel view.
    // Both endpoints share queries.ts so the counting rules stay in sync.
    const supervisor = {
      latestReport: summarizeSupervisorReport(
        await fetchLatestSupervisorReport(db, hiveId),
      ),
    };

    const initiative = {
      latestRun: summarizeInitiativeRun(
        await fetchLatestInitiativeRun(db, hiveId),
      ),
      last7d: await fetchInitiativeRunSummary(db, hiveId, 24 * 7),
    };

    const creationPause = await getHiveCreationPause(db, hiveId);
    const operationLock = {
      creationPause,
      resumeReadiness: await getHiveResumeReadiness(db, {
        hiveId,
        creationPause,
      }),
    };

    const [ideasRow] = (await db`
      SELECT
        COUNT(*) FILTER (WHERE status = 'open')::int AS open_ideas_count,
        MAX(reviewed_at) AS last_ideas_review_at
      FROM hive_ideas
      WHERE hive_id = ${hiveId}::uuid
    `) as unknown as Array<{
      open_ideas_count: number;
      last_ideas_review_at: Date | null;
    }>;

    // Activity counters — raw counts for the Brief's top band.
    const [activity] = (await db`
      SELECT
        (SELECT COUNT(*) FROM tasks
          WHERE hive_id = ${hiveId}::uuid AND status = 'completed'
            AND updated_at > NOW() - INTERVAL '24 hours') AS tasks_completed_24h,
        (SELECT COUNT(*) FROM tasks
          WHERE hive_id = ${hiveId}::uuid
            AND (
              status = 'failed'
              OR (
                status = 'unresolvable'
                AND NOT EXISTS (
                  SELECT 1
                  FROM tasks child
                  WHERE child.parent_task_id = tasks.id
                    AND child.assigned_to = 'doctor'
                    AND child.status IN ('pending', 'active', 'claimed', 'running', 'in_review', 'blocked')
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM decisions d
                  WHERE d.task_id = tasks.id
                    AND d.status IN ('ea_review', 'pending', 'resolved')
                    AND d.kind IN ('unresolvable_task_triage', 'supervisor_flagged', 'quality_doctor_recommendation')
                )
              )
            )
            AND updated_at > NOW() - INTERVAL '24 hours') AS tasks_failed_24h,
        (SELECT COUNT(*) FROM goals
          WHERE hive_id = ${hiveId}::uuid AND status = 'achieved'
            AND updated_at > NOW() - INTERVAL '7 days') AS goals_completed_7d,
        (SELECT COUNT(*) FROM tasks
          WHERE hive_id = ${hiveId}::uuid
            AND status = 'unresolvable'
            AND NOT EXISTS (
              SELECT 1
              FROM tasks child
              WHERE child.parent_task_id = tasks.id
                AND child.assigned_to = 'doctor'
                AND child.status IN ('pending', 'active', 'claimed', 'running', 'in_review', 'blocked')
            )
            AND NOT EXISTS (
              SELECT 1
              FROM decisions d
              WHERE d.task_id = tasks.id
                AND d.status IN ('ea_review', 'pending', 'resolved')
                AND d.kind IN ('unresolvable_task_triage', 'supervisor_flagged', 'quality_doctor_recommendation')
            )) AS unresolvable_tasks,
        (SELECT COUNT(*) FROM credentials
          WHERE (hive_id = ${hiveId}::uuid OR hive_id IS NULL)
            AND expires_at IS NOT NULL
            AND expires_at < NOW() + INTERVAL '7 days') AS expiring_creds
    `) as unknown as {
      tasks_completed_24h: string;
      tasks_failed_24h: string;
      goals_completed_7d: string;
      unresolvable_tasks: string;
      expiring_creds: string;
    }[];

    // Derive per-goal health.
    const goals = (goalRows as unknown as Record<string, unknown>[]).map((g) => {
      const total = Number(g.total);
      const done = Number(g.done);
      const failed = Number(g.failed);
      const open = Number(g.open);
      const idle = Number(g.idle_hours ?? 0);
      const pendingDecisions = Number(g.pending_decisions);
      const status = g.status as string;

      let health: GoalHealth;
      if (status === "achieved") health = "achieved";
      else if (pendingDecisions > 0) health = "waiting_on_owner";
      else if (idle > 48 && open > 0) health = "stalled";
      else if (failed > done && total > 2) health = "at_risk";
      else health = "on_track";

      return {
        id: g.id as string,
        title: g.title as string,
        status,
        health,
        progress: { done, failed, open, total },
        idleHours: Math.round(idle * 10) / 10,
        pendingDecisions,
        budgetCents: g.budget_cents as number | null,
        spentCents: g.spent_cents as number | null,
      };
    });

    const flags = {
      urgentDecisions: (decisionRows as unknown as { priority: string }[]).filter(
        (d) => d.priority === "urgent",
      ).length,
      pendingDecisions: decisionRows.length,
      pendingQualityFeedback: Number(qualityFeedbackRow?.pending_quality_feedback ?? 0),
      totalPendingDecisions: decisionRows.length,
      stalledGoals: goals.filter((g) => g.health === "stalled").length,
      waitingGoals: goals.filter((g) => g.health === "waiting_on_owner").length,
      atRiskGoals: goals.filter((g) => g.health === "at_risk").length,
      unresolvableTasks: Number(activity.unresolvable_tasks),
      expiringCreds: Number(activity.expiring_creds),
    };

    return jsonOk({
      flags,
      pendingDecisions: (decisionRows as unknown as Record<string, unknown>[]).map((d) => ({
        id: d.id,
        title: d.title,
        priority: d.priority,
        context: (d.context as string).slice(0, 500),
        createdAt: d.created_at,
        ageHours: Math.round(Number(d.age_hours) * 10) / 10,
      })),
      goals,
      recentCompletions: (recentCompletionRows as unknown as Record<string, unknown>[]).map(
        (t) => ({
          id: t.id,
          title: t.title,
          role: t.assigned_to,
          completedAt: t.updated_at,
        }),
      ),
      newInsights: (newInsightRows as unknown as Record<string, unknown>[]).map((i) => ({
        id: i.id,
        content: i.content,
        priority: i.priority,
        connectionType: i.connection_type,
        confidence: i.confidence,
      })),
      costs: {
        todayCents: today,
        weekCents: week,
        monthCents: month,
      },
      activity: {
        tasksCompleted24h: Number(activity.tasks_completed_24h),
        tasksFailed24h: Number(activity.tasks_failed_24h),
        goalsCompleted7d: Number(activity.goals_completed_7d),
      },
      supervisor,
      initiative,
      operationLock,
      ideas: {
        openCount: Number(ideasRow?.open_ideas_count ?? 0),
        lastReviewAt: ideasRow?.last_ideas_review_at?.toISOString() ?? null,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[api/brief] failed:", err);
    return jsonError("Failed to assemble brief", 500);
  }
}

export function createBriefGetHandler(db: Sql = appSql) {
  return async function GET(request: Request) {
    return getBrief(request, db);
  };
}

export const GET = createBriefGetHandler();
