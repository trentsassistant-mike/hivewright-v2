import { describe, it, expect, beforeEach } from "vitest";
import { CronExpressionParser } from "cron-parser";
import { testSql as sql, truncateAll } from "../../tests/_lib/test-db";
import { seedDefaultSchedules } from "@/hives/seed-schedules";

const HIVE = "cccccccc-cccc-cccc-cccc-cccccccccccc";

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type, description)
    VALUES (${HIVE}, 'seed-biz', 'Seed Co', 'digital', 'A test hive for schedule seeding')
  `;
});

describe("seedDefaultSchedules", () => {
  it("creates the daily world-scan, supervisor-heartbeat, ideas-daily-review, initiative-evaluation, LLM release-scan, current-tech research, and task-quality feedback schedules for a new hive", async () => {
    const expectedWorldScanNextRun = CronExpressionParser.parse("0 7 * * *").next().toDate();

    const res = await seedDefaultSchedules(sql, {
      id: HIVE,
      name: "Seed Co",
      description: "A test hive",
    });
    expect(res.created).toBe(7);
    expect(res.skipped).toBe(0);

    const rows = await sql`
      SELECT cron_expression, enabled, task_template, next_run_at FROM schedules
      WHERE hive_id = ${HIVE}::uuid
      ORDER BY cron_expression ASC
    `;
    expect(rows).toHaveLength(7);

    // World scan row (cron "0 7 * * *" sorts after "*/15 * * * *")
    const worldScan = rows.find(
      (r) => (r.task_template as { title: string }).title === "Daily world scan",
    );
    expect(worldScan).toBeDefined();
    expect(worldScan!.cron_expression).toBe("0 7 * * *");
    expect(worldScan!.enabled).toBe(true);
    expect(worldScan!.next_run_at).not.toBeNull();
    expect(worldScan!.next_run_at.getTime()).toBeGreaterThan(Date.now());
    expect(worldScan!.next_run_at.getTime()).toBe(expectedWorldScanNextRun.getTime());
    const worldScanTemplate = worldScan!.task_template as {
      assignedTo: string;
      title: string;
      brief: string;
    };
    expect(worldScanTemplate.assignedTo).toBe("research-analyst");
    expect(worldScanTemplate.brief).toMatch(/Seed Co/);
    expect(worldScanTemplate.brief).toMatch(/A test hive/);

    // Supervisor heartbeat row — schedule timer keys off task_template.kind
    const heartbeat = rows.find(
      (r) =>
        (r.task_template as { kind?: string }).kind ===
        "hive-supervisor-heartbeat",
    );
    expect(heartbeat).toBeDefined();
    expect(heartbeat!.cron_expression).toBe("*/15 * * * *");
    expect(heartbeat!.enabled).toBe(true);
    const heartbeatTemplate = heartbeat!.task_template as {
      kind: string;
      assignedTo: string;
      title: string;
      brief: string;
    };
    expect(heartbeatTemplate.kind).toBe("hive-supervisor-heartbeat");
    expect(heartbeatTemplate.assignedTo).toBe("hive-supervisor");
    expect(heartbeatTemplate.title).toBe("Hive supervisor heartbeat");

    const ideasReview = rows.find(
      (r) => (r.task_template as { kind?: string }).kind === "ideas-daily-review",
    );
    expect(ideasReview).toBeDefined();
    expect(ideasReview!.cron_expression).toBe("0 9 * * *");
    expect(ideasReview!.enabled).toBe(true);
    expect(ideasReview!.next_run_at).not.toBeNull();
    const ideasTemplate = ideasReview!.task_template as {
      kind: string;
      assignedTo: string;
      title: string;
    };
    expect(ideasTemplate.kind).toBe("ideas-daily-review");
    expect(ideasTemplate.assignedTo).toBe("ideas-curator");
    expect(ideasTemplate.title).toBe("Ideas daily review");

    const initiativeEvaluation = rows.find(
      (r) => (r.task_template as { kind?: string }).kind === "initiative-evaluation",
    );
    expect(initiativeEvaluation).toBeDefined();
    expect(initiativeEvaluation!.cron_expression).toBe("0 * * * *");
    expect(initiativeEvaluation!.enabled).toBe(true);
    expect(initiativeEvaluation!.next_run_at).not.toBeNull();
    const initiativeTemplate = initiativeEvaluation!.task_template as {
      kind: string;
      assignedTo: string;
      title: string;
      brief: string;
    };
    expect(initiativeTemplate.kind).toBe("initiative-evaluation");
    expect(initiativeTemplate.assignedTo).toBe("initiative-engine");
    expect(initiativeTemplate.title).toBe("Initiative evaluation");
    expect(initiativeTemplate.brief).toBe("(populated at run time)");

    const releaseScan = rows.find(
      (r) => (r.task_template as { kind?: string }).kind === "llm-release-scan",
    );
    expect(releaseScan).toBeDefined();
    expect(releaseScan!.cron_expression).toBe("0 8 * * 1");
    expect(releaseScan!.enabled).toBe(true);
    expect(releaseScan!.next_run_at).not.toBeNull();
    const releaseScanTemplate = releaseScan!.task_template as {
      kind: string;
      assignedTo: string;
      title: string;
      brief: string;
    };
    expect(releaseScanTemplate.kind).toBe("llm-release-scan");
    expect(releaseScanTemplate.assignedTo).toBe("initiative-engine");
    expect(releaseScanTemplate.title).toBe("Weekly LLM release scan");
    expect(releaseScanTemplate.brief).toBe("(populated at run time)");

    const currentTechResearch = rows.find(
      (r) => (r.task_template as { kind?: string }).kind === "current-tech-research-daily",
    );
    expect(currentTechResearch).toBeDefined();
    expect(currentTechResearch!.cron_expression).toBe("30 8 * * *");
    expect(currentTechResearch!.enabled).toBe(true);
    expect(currentTechResearch!.next_run_at).not.toBeNull();
    const currentTechResearchTemplate = currentTechResearch!.task_template as {
      kind: string;
      assignedTo: string;
      title: string;
      brief: string;
    };
    expect(currentTechResearchTemplate.kind).toBe("current-tech-research-daily");
    expect(currentTechResearchTemplate.assignedTo).toBe("goal-supervisor");
    expect(currentTechResearchTemplate.title).toBe("Current tech research daily cycle");
    expect(currentTechResearchTemplate.brief).toBe("(populated at run time)");

    const qualityFeedback = rows.find(
      (r) => (r.task_template as { kind?: string }).kind === "task-quality-feedback-sample",
    );
    expect(qualityFeedback).toBeDefined();
    expect(qualityFeedback!.cron_expression).toBe("0 10 * * *");
    expect(qualityFeedback!.enabled).toBe(true);
    expect(qualityFeedback!.next_run_at).not.toBeNull();
    const qualityFeedbackTemplate = qualityFeedback!.task_template as {
      kind: string;
      assignedTo: string;
      title: string;
      brief: string;
    };
    expect(qualityFeedbackTemplate.kind).toBe("task-quality-feedback-sample");
    expect(qualityFeedbackTemplate.assignedTo).toBe("initiative-engine");
    expect(qualityFeedbackTemplate.title).toBe("Task quality feedback sample");
    expect(qualityFeedbackTemplate.brief).toBe("(populated at run time)");
  });

  it("can create the default recurring work paused for owner setup", async () => {
    const res = await seedDefaultSchedules(sql, {
      id: HIVE,
      name: "Seed Co",
      description: "A test hive",
    }, {
      enabled: false,
    });

    expect(res.created).toBe(7);

    const rows = await sql`
      SELECT enabled FROM schedules
      WHERE hive_id = ${HIVE}::uuid
    `;
    expect(rows).toHaveLength(7);
    expect(rows.every((row) => row.enabled === false)).toBe(true);
  });

  it("is idempotent — second run does not create duplicates of either schedule", async () => {
    await seedDefaultSchedules(sql, {
      id: HIVE,
      name: "Seed Co",
      description: null,
    });
    const res = await seedDefaultSchedules(sql, {
      id: HIVE,
      name: "Seed Co",
      description: null,
    });
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(7);

    const [{ c: total }] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules WHERE hive_id = ${HIVE}::uuid
    `) as unknown as { c: number }[];
    expect(total).toBe(7);

    // Exactly one heartbeat row per hive — this is the invariant the
    // schedule timer relies on so supervisor runs don't stack up.
    const [{ c: heartbeats }] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${HIVE}::uuid
        AND task_template ->> 'kind' = 'hive-supervisor-heartbeat'
    `) as unknown as { c: number }[];
    expect(heartbeats).toBe(1);

    const [{ c: worldScans }] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${HIVE}::uuid
        AND task_template ->> 'title' = 'Daily world scan'
    `) as unknown as { c: number }[];
    expect(worldScans).toBe(1);

    const [{ c: ideasReviews }] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${HIVE}::uuid
        AND task_template ->> 'kind' = 'ideas-daily-review'
    `) as unknown as { c: number }[];
    expect(ideasReviews).toBe(1);

    const [{ c: initiativeEvaluations }] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${HIVE}::uuid
        AND task_template ->> 'kind' = 'initiative-evaluation'
    `) as unknown as { c: number }[];
    expect(initiativeEvaluations).toBe(1);

    const [{ c: releaseScans }] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${HIVE}::uuid
        AND task_template ->> 'kind' = 'llm-release-scan'
    `) as unknown as { c: number }[];
    expect(releaseScans).toBe(1);

    const [{ c: currentTechResearchRuns }] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${HIVE}::uuid
        AND task_template ->> 'kind' = 'current-tech-research-daily'
    `) as unknown as { c: number }[];
    expect(currentTechResearchRuns).toBe(1);

    const [{ c: qualityFeedbackSamples }] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${HIVE}::uuid
        AND task_template ->> 'kind' = 'task-quality-feedback-sample'
    `) as unknown as { c: number }[];
    expect(qualityFeedbackSamples).toBe(1);
  });

  it("treats legacy stringified default templates as existing schedules", async () => {
    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, created_by)
      VALUES
        (
          ${HIVE}::uuid,
          '0 9 * * *',
          ${JSON.stringify({
            kind: "ideas-daily-review",
            assignedTo: "ideas-curator",
            title: "Ideas daily review",
            brief: "(populated at run time)",
          })},
          false,
          'system:seed-default-schedules'
        ),
        (
          ${HIVE}::uuid,
          '30 8 * * *',
          ${JSON.stringify({
            kind: "current-tech-research-daily",
            assignedTo: "goal-supervisor",
            title: "Current tech research daily cycle",
            brief: "(populated at run time)",
          })},
          false,
          'system:seed-default-schedules'
        )
    `;

    const res = await seedDefaultSchedules(sql, {
      id: HIVE,
      name: "Seed Co",
      description: null,
    });

    expect(res.created).toBe(5);
    expect(res.skipped).toBe(2);

    const [{ currentTechResearchRuns }] = await sql<{ currentTechResearchRuns: number }[]>`
      WITH normalized AS (
        SELECT CASE
          WHEN jsonb_typeof(task_template) = 'string' THEN (task_template #>> '{}')::jsonb
          ELSE task_template
        END AS template
        FROM schedules
        WHERE hive_id = ${HIVE}::uuid
      )
      SELECT COUNT(*)::int AS "currentTechResearchRuns"
      FROM normalized
      WHERE template ->> 'kind' = 'current-tech-research-daily'
    `;
    expect(currentTechResearchRuns).toBe(1);

    const [{ ideasReviews }] = await sql<{ ideasReviews: number }[]>`
      WITH normalized AS (
        SELECT CASE
          WHEN jsonb_typeof(task_template) = 'string' THEN (task_template #>> '{}')::jsonb
          ELSE task_template
        END AS template
        FROM schedules
        WHERE hive_id = ${HIVE}::uuid
      )
      SELECT COUNT(*)::int AS "ideasReviews"
      FROM normalized
      WHERE template ->> 'kind' = 'ideas-daily-review'
    `;
    expect(ideasReviews).toBe(1);
  });

  it("backfills just the missing schedule when one already exists (migration parity)", async () => {
    // Simulate the migration 0031 backfill path: heartbeat already seeded,
    // but the world scan is missing (or vice versa). The seeder should
    // only create the gap and skip the one that's present.
    await sql`
      INSERT INTO schedules (hive_id, cron_expression, task_template, enabled, created_by)
      VALUES (
        ${HIVE}::uuid,
        '*/15 * * * *',
        ${sql.json({
          kind: "hive-supervisor-heartbeat",
          assignedTo: "hive-supervisor",
          title: "Hive supervisor heartbeat",
          brief: "(populated at run time)",
        })},
        true,
        'migration:0031_hive_supervisor'
      )
    `;

    const res = await seedDefaultSchedules(sql, {
      id: HIVE,
      name: "Seed Co",
      description: null,
    });
    expect(res.created).toBe(6); // world scan + ideas review + initiative evaluation + release scan + current tech research + quality feedback filled in
    expect(res.skipped).toBe(1); // heartbeat already present

    const [{ c: heartbeats }] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${HIVE}::uuid
        AND task_template ->> 'kind' = 'hive-supervisor-heartbeat'
    `) as unknown as { c: number }[];
    expect(heartbeats).toBe(1);

    const [{ c: ideasReviews }] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${HIVE}::uuid
        AND task_template ->> 'kind' = 'ideas-daily-review'
    `) as unknown as { c: number }[];
    expect(ideasReviews).toBe(1);

    const [{ c: initiativeEvaluations }] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${HIVE}::uuid
        AND task_template ->> 'kind' = 'initiative-evaluation'
    `) as unknown as { c: number }[];
    expect(initiativeEvaluations).toBe(1);

    const [{ c: releaseScans }] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${HIVE}::uuid
        AND task_template ->> 'kind' = 'llm-release-scan'
    `) as unknown as { c: number }[];
    expect(releaseScans).toBe(1);

    const [{ c: currentTechResearchRuns }] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${HIVE}::uuid
        AND task_template ->> 'kind' = 'current-tech-research-daily'
    `) as unknown as { c: number }[];
    expect(currentTechResearchRuns).toBe(1);

    const [{ c: qualityFeedbackSamples }] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${HIVE}::uuid
        AND task_template ->> 'kind' = 'task-quality-feedback-sample'
    `) as unknown as { c: number }[];
    expect(qualityFeedbackSamples).toBe(1);
  });
});
