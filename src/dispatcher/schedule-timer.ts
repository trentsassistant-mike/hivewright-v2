import type { Sql } from "postgres";
import { CronExpressionParser } from "cron-parser";

/**
 * Shape of the task_template JSON on every schedules row. `kind` is
 * optional — absent/unknown kinds fall through to the standard path
 * (insert a task for the assigned executor). The hive-supervisor
 * heartbeat short-circuits to runSupervisor(hiveId) instead.
 */
interface ScheduleTaskTemplate {
  kind?: string;
  goalId?: string | null;
  projectId?: string | null;
  project_id?: string | null;
  assignedTo?: string;
  title?: string;
  brief?: string;
  qaRequired?: boolean;
  priority?: number;
}

async function resolveScheduledTaskProjectId(
  sql: Sql,
  hiveId: string,
  explicitProjectId: string | null | undefined,
): Promise<string | null> {
  const normalized = typeof explicitProjectId === "string" && explicitProjectId.trim() !== ""
    ? explicitProjectId
    : null;
  if (normalized) return normalized;

  const projects = await sql<{ id: string }[]>`
    SELECT id
    FROM projects
    WHERE hive_id = ${hiveId}
    ORDER BY created_at ASC, id ASC
    LIMIT 2
  `;

  return projects.length === 1 ? projects[0].id : null;
}

export async function checkAndFireSchedules(sql: Sql): Promise<number> {
  const dueSchedules = await sql`
    SELECT * FROM schedules
    WHERE enabled = true
      AND next_run_at <= NOW()
  `;

  let created = 0;

  for (const schedule of dueSchedules) {
    const rawTemplate = schedule.task_template;
    const template = (typeof rawTemplate === "string"
      ? JSON.parse(rawTemplate)
      : rawTemplate) as ScheduleTaskTemplate;

    if (template.kind === "hive-supervisor-heartbeat") {
      // Short-circuit to the supervisor runtime instead of enqueuing a
      // placeholder task. Isolated in its own try so a single hive's
      // failure can't block the rest of the schedule sweep from advancing
      // last_run_at / next_run_at — otherwise a stuck hive would cause
      // its schedule to refire on every tick.
      try {
        const { runSupervisor } = await import("../supervisor");
        await runSupervisor(sql, schedule.hive_id);
      } catch (err) {
        console.error(
          `[schedule-timer] runSupervisor failed for hive ${schedule.hive_id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    } else if (template.kind === "ideas-daily-review") {
      try {
        const { runIdeasDailyReview } = await import("../ideas/daily-review");
        await runIdeasDailyReview(sql, schedule.hive_id);
      } catch (err) {
        console.error(
          `[schedule-timer] runIdeasDailyReview failed for hive ${schedule.hive_id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    } else if (template.kind === "initiative-evaluation") {
      try {
        const { runInitiativeEvaluation } = await import("../initiative-engine");
        await runInitiativeEvaluation(sql, {
          hiveId: schedule.hive_id,
          trigger: {
            kind: "schedule",
            scheduleId: schedule.id,
            targetGoalId: template.goalId ?? null,
          },
        });
      } catch (err) {
        console.error(
          `[schedule-timer] runInitiativeEvaluation failed for hive ${schedule.hive_id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    } else if (template.kind === "llm-release-scan") {
      try {
        const { runLlmReleaseScan } = await import("../llm-release-scan");
        await runLlmReleaseScan(sql, {
          hiveId: schedule.hive_id,
          trigger: {
            kind: "schedule",
            scheduleId: schedule.id,
          },
        });
      } catch (err) {
        console.error(
          `[schedule-timer] runLlmReleaseScan failed for hive ${schedule.hive_id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    } else if (template.kind === "current-tech-research-daily") {
      try {
        const { runCurrentTechResearchDaily } = await import("../current-tech-research");
        await runCurrentTechResearchDaily(sql, {
          hiveId: schedule.hive_id,
          trigger: {
            kind: "schedule",
            scheduleId: schedule.id,
          },
        });
      } catch (err) {
        console.error(
          `[schedule-timer] runCurrentTechResearchDaily failed for hive ${schedule.hive_id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    } else if (template.kind === "task-quality-feedback-sample") {
      try {
        const { runOwnerFeedbackSampleSweep } = await import("../quality/owner-feedback-sampler");
        await runOwnerFeedbackSampleSweep(sql, {
          hiveId: schedule.hive_id,
        });
      } catch (err) {
        console.error(
          `[schedule-timer] runOwnerFeedbackSampleSweep failed for hive ${schedule.hive_id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    } else {
      const projectId = await resolveScheduledTaskProjectId(
        sql,
        schedule.hive_id,
        template.projectId ?? template.project_id ?? null,
      );

      await sql`
        INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, qa_required, priority, project_id)
        VALUES (
          ${schedule.hive_id},
          ${template.assignedTo ?? null},
          'scheduler',
          ${template.title ?? null},
          ${template.brief ?? null},
          ${template.qaRequired ?? false},
          ${template.priority ?? 5},
          ${projectId}
        )
      `;
    }

    const interval = CronExpressionParser.parse(schedule.cron_expression);
    const nextRun = interval.next().toDate();

    await sql`
      UPDATE schedules
      SET last_run_at = NOW(), next_run_at = ${nextRun}
      WHERE id = ${schedule.id}
    `;

    created++;
  }

  return created;
}
