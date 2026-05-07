import type { Sql } from "postgres";
import { CronExpressionParser } from "cron-parser";

/**
 * Seed a new hive with the built-in default schedules:
 *   1. "Daily world scan" — research-analyst task every morning at 07:00
 *      that surveys industry signals relevant to the hive and surfaces
 *      opportunities as Tier 2 decisions + hive_memory entries.
 *   2. "Hive supervisor heartbeat" — work-integrity watchdog that fires
 *      every 15 minutes. The schedule timer short-circuits this kind to
 *      runSupervisor(hiveId) instead of enqueuing a task (see
 *      src/dispatcher/schedule-timer.ts).
 *   3. "Ideas daily review" — once-daily ideas backlog review keyed on
 *      task_template.kind so schedule-timer can short-circuit to the
 *      runtime review seam instead of enqueuing a placeholder task.
 *   4. "Initiative evaluation" — hourly dormant-goal evaluation keyed on
 *      task_template.kind so schedule-timer can short-circuit to the
 *      initiative engine runtime instead of enqueuing a placeholder task.
 *   5. "Weekly LLM release scan" — weekly provider release/pricing scan keyed
 *      on task_template.kind so schedule-timer can short-circuit to the
 *      owner-gated proposal runtime instead of enqueuing a placeholder task.
 *   6. "Current tech research daily cycle" — daily kickoff for the recurring
 *      Current tech research goal. The runtime creates an idempotent dated
 *      goal-comment wake signal rather than a standalone task.
 *   7. "Task quality feedback sample" — daily random owner-feedback sampling
 *      keyed on task_template.kind so schedule-timer can run the sampler
 *      directly instead of enqueuing a placeholder task.
 *
 * Each schedule is seeded via a `WHERE NOT EXISTS` guard so re-running
 * the seeder is a no-op. This mirrors the backfill done in migration
 * 0031_hive_supervisor.sql for hives that predate the supervisor, so
 * the runtime and migration paths stay in sync.
 */

const WORLD_SCAN_CRON = "0 7 * * *"; // every day at 07:00 local
const WORLD_SCAN_TITLE = "Daily world scan";

const WORLD_SCAN_BRIEF = (hiveName: string, hiveDescription: string | null) => `
Run the daily world scan for ${hiveName}.

${hiveDescription ? `Hive context:\n${hiveDescription}\n\n` : ""}Your job today is to look for anything that could materially change how
this hive operates, makes money, or competes:

1. Trends, news, or tools released in the last 24-48 hours that are
   relevant to this hive's industry.
2. Competitor moves (pricing, features, launches) worth noting.
3. Regulatory or economic signals that might hit the hive's customers.
4. New AI models, libraries, or workflows that HiveWright itself could
   adopt for this hive's agents.

Produce:

- A concise summary of what you found (5-10 bullet points max).
- For each item that the owner should *act on*, create a Tier 2 decision
  via the create_decision tool with a clear recommendation. Do NOT create
  a decision for items that are just interesting — only act-worthy ones.
- If a decision is a genuine named multi-way choice (for example runtime,
  auth, product, or process paths), populate options[] with stable key,
  human-readable label, consequence/tradeoff, and response/canonicalResponse.
  Keep natural yes/no approval decisions simple without options[].
- Insert any durable facts (seasonal patterns, confirmed competitor
  pricing, regulatory changes) into hive_memory so other roles benefit.

Scope: default web-research allowance. If you can't reach the web, say
so and return what you can infer from the hive's existing memory and
recent work products. Do NOT fabricate facts.

Acceptance: the summary is written; decisions are created for the
items that need action; hive_memory has at least one new entry if
anything durable was learned.
`.trim();

const SUPERVISOR_HEARTBEAT_CRON = "*/15 * * * *";
const SUPERVISOR_HEARTBEAT_KIND = "hive-supervisor-heartbeat";
const SUPERVISOR_HEARTBEAT_TITLE = "Hive supervisor heartbeat";

const SUPERVISOR_HEARTBEAT_TEMPLATE = {
  kind: SUPERVISOR_HEARTBEAT_KIND,
  assignedTo: "hive-supervisor",
  title: SUPERVISOR_HEARTBEAT_TITLE,
  brief: "(populated at run time)",
};

const IDEAS_DAILY_REVIEW_CRON = "0 9 * * *";
const IDEAS_DAILY_REVIEW_KIND = "ideas-daily-review";
const IDEAS_DAILY_REVIEW_TITLE = "Ideas daily review";

const IDEAS_DAILY_REVIEW_TEMPLATE = {
  kind: IDEAS_DAILY_REVIEW_KIND,
  assignedTo: "ideas-curator",
  title: IDEAS_DAILY_REVIEW_TITLE,
  brief: "(populated at run time)",
};

const INITIATIVE_EVALUATION_CRON = "0 * * * *";
const INITIATIVE_EVALUATION_KIND = "initiative-evaluation";
const INITIATIVE_EVALUATION_TITLE = "Initiative evaluation";

const INITIATIVE_EVALUATION_TEMPLATE = {
  kind: INITIATIVE_EVALUATION_KIND,
  assignedTo: "initiative-engine",
  title: INITIATIVE_EVALUATION_TITLE,
  brief: "(populated at run time)",
};

const LLM_RELEASE_SCAN_CRON = "0 8 * * 1";
const LLM_RELEASE_SCAN_KIND = "llm-release-scan";
const LLM_RELEASE_SCAN_TITLE = "Weekly LLM release scan";

const LLM_RELEASE_SCAN_TEMPLATE = {
  kind: LLM_RELEASE_SCAN_KIND,
  assignedTo: "initiative-engine",
  title: LLM_RELEASE_SCAN_TITLE,
  brief: "(populated at run time)",
};

const CURRENT_TECH_RESEARCH_CRON = "30 8 * * *";
const CURRENT_TECH_RESEARCH_KIND = "current-tech-research-daily";
const CURRENT_TECH_RESEARCH_TITLE = "Current tech research daily cycle";

const CURRENT_TECH_RESEARCH_TEMPLATE = {
  kind: CURRENT_TECH_RESEARCH_KIND,
  assignedTo: "goal-supervisor",
  title: CURRENT_TECH_RESEARCH_TITLE,
  brief: "(populated at run time)",
};

const TASK_QUALITY_FEEDBACK_CRON = "0 10 * * *";
const TASK_QUALITY_FEEDBACK_KIND = "task-quality-feedback-sample";
const TASK_QUALITY_FEEDBACK_TITLE = "Task quality feedback sample";

const TASK_QUALITY_FEEDBACK_TEMPLATE = {
  kind: TASK_QUALITY_FEEDBACK_KIND,
  assignedTo: "initiative-engine",
  title: TASK_QUALITY_FEEDBACK_TITLE,
  brief: "(populated at run time)",
};

export interface SeedResult {
  created: number;
  skipped: number;
}

function legacyJsonFieldPattern(field: "kind" | "title", value: string): string {
  const escaped = value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  return `"${field}"[[:space:]]*:[[:space:]]*"${escaped}"`;
}

async function hasScheduleWithTemplateKind(
  sql: Sql,
  hiveId: string,
  kind: string,
): Promise<boolean> {
  const rows = await sql`
    SELECT id FROM schedules
    WHERE hive_id = ${hiveId}::uuid
      AND (
        task_template ->> 'kind' = ${kind}
        OR (
          jsonb_typeof(task_template) = 'string'
          AND task_template #>> '{}' ~ ${legacyJsonFieldPattern("kind", kind)}
        )
      )
    LIMIT 1
  `;
  return rows.length > 0;
}

async function hasScheduleWithTemplateTitle(
  sql: Sql,
  hiveId: string,
  title: string,
): Promise<boolean> {
  const rows = await sql`
    SELECT id FROM schedules
    WHERE hive_id = ${hiveId}::uuid
      AND (
        task_template ->> 'title' = ${title}
        OR (
          jsonb_typeof(task_template) = 'string'
          AND task_template #>> '{}' ~ ${legacyJsonFieldPattern("title", title)}
        )
      )
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function seedDefaultSchedules(
  sql: Sql,
  hive: { id: string; name: string; description: string | null },
  options: { enabled?: boolean } = {},
): Promise<SeedResult> {
  const enabled = options.enabled ?? true;
  const result: SeedResult = { created: 0, skipped: 0 };

  // 1. Daily world scan — keyed on task_template.title so a hive that
  // already has this schedule is left untouched.
  if (await hasScheduleWithTemplateTitle(sql, hive.id, WORLD_SCAN_TITLE)) {
    result.skipped++;
  } else {
    const nextRunAt = CronExpressionParser.parse(WORLD_SCAN_CRON).next().toDate();
    const template = {
      assignedTo: "research-analyst",
      title: WORLD_SCAN_TITLE,
      brief: WORLD_SCAN_BRIEF(hive.name, hive.description),
      qaRequired: false,
      priority: 4,
    };

    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${hive.id}::uuid,
        ${WORLD_SCAN_CRON},
        ${sql.json(template)},
        ${enabled},
        ${nextRunAt},
        'system:seed-default-schedules'
      )
    `;
    result.created++;
  }

  // 2. Hive supervisor heartbeat — keyed on task_template.kind so this
  // stays aligned with the migration 0031 backfill guard.
  if (await hasScheduleWithTemplateKind(sql, hive.id, SUPERVISOR_HEARTBEAT_KIND)) {
    result.skipped++;
  } else {
    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${hive.id}::uuid,
        ${SUPERVISOR_HEARTBEAT_CRON},
        ${sql.json(SUPERVISOR_HEARTBEAT_TEMPLATE)},
        ${enabled},
        NOW() + interval '1 minute',
        'system:seed-default-schedules'
      )
    `;
    result.created++;
  }

  // 3. Ideas daily review — keyed on task_template.kind so the runtime
  // dispatch branch and migration backfill guard share the same invariant:
  // exactly one ideas-daily-review schedule per hive.
  if (await hasScheduleWithTemplateKind(sql, hive.id, IDEAS_DAILY_REVIEW_KIND)) {
    result.skipped++;
  } else {
    const nextRunAt = CronExpressionParser.parse(IDEAS_DAILY_REVIEW_CRON).next().toDate();

    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${hive.id}::uuid,
        ${IDEAS_DAILY_REVIEW_CRON},
        ${sql.json(IDEAS_DAILY_REVIEW_TEMPLATE)},
        ${enabled},
        ${nextRunAt},
        'system:seed-default-schedules'
      )
    `;
    result.created++;
  }

  // 4. Initiative evaluation — keyed on task_template.kind so both the
  // runtime dispatcher branch and the rollout migration share the same
  // invariant: exactly one initiative-evaluation schedule per hive.
  if (await hasScheduleWithTemplateKind(sql, hive.id, INITIATIVE_EVALUATION_KIND)) {
    result.skipped++;
  } else {
    const nextRunAt = CronExpressionParser.parse(INITIATIVE_EVALUATION_CRON).next().toDate();

    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${hive.id}::uuid,
        ${INITIATIVE_EVALUATION_CRON},
        ${sql.json(INITIATIVE_EVALUATION_TEMPLATE)},
        ${enabled},
        ${nextRunAt},
        'system:seed-default-schedules'
      )
    `;
    result.created++;
  }

  // 5. Weekly LLM release scan — keyed on task_template.kind so the
  // runtime branch and backfill seeding path keep exactly one scan per hive.
  if (await hasScheduleWithTemplateKind(sql, hive.id, LLM_RELEASE_SCAN_KIND)) {
    result.skipped++;
  } else {
    const nextRunAt = CronExpressionParser.parse(LLM_RELEASE_SCAN_CRON).next().toDate();

    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${hive.id}::uuid,
        ${LLM_RELEASE_SCAN_CRON},
        ${sql.json(LLM_RELEASE_SCAN_TEMPLATE)},
        ${enabled},
        ${nextRunAt},
        'system:seed-default-schedules'
      )
    `;
    result.created++;
  }

  // 6. Current tech research daily cycle — keyed on task_template.kind so the
  // runtime branch and backfill seeding path keep exactly one kickoff schedule
  // per hive.
  if (await hasScheduleWithTemplateKind(sql, hive.id, CURRENT_TECH_RESEARCH_KIND)) {
    result.skipped++;
  } else {
    const nextRunAt = CronExpressionParser.parse(CURRENT_TECH_RESEARCH_CRON).next().toDate();

    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${hive.id}::uuid,
        ${CURRENT_TECH_RESEARCH_CRON},
        ${sql.json(CURRENT_TECH_RESEARCH_TEMPLATE)},
        ${enabled},
        ${nextRunAt},
        'system:seed-default-schedules'
      )
    `;
    result.created++;
  }

  // 7. Task quality feedback sample — keyed on task_template.kind so the
  // runtime branch and backfill seeding path keep exactly one daily sampler
  // per hive.
  if (await hasScheduleWithTemplateKind(sql, hive.id, TASK_QUALITY_FEEDBACK_KIND)) {
    result.skipped++;
  } else {
    const nextRunAt = CronExpressionParser.parse(TASK_QUALITY_FEEDBACK_CRON).next().toDate();

    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, next_run_at, created_by)
      VALUES (
        ${hive.id}::uuid,
        ${TASK_QUALITY_FEEDBACK_CRON},
        ${sql.json(TASK_QUALITY_FEEDBACK_TEMPLATE)},
        ${enabled},
        ${nextRunAt},
        'system:seed-default-schedules'
      )
    `;
    result.created++;
  }

  return result;
}
