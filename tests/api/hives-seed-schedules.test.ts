/**
 * End-to-end coverage for the new-hive creation path in POST /api/hives.
 *
 * Closes the QA gap from failed task 77159477: the failed task asked for
 * proof that the real creation path (not just the helper) seeds exactly
 * one `hive-supervisor-heartbeat` row, one daily world-scan row, one
 * `ideas-daily-review` row, one `initiative-evaluation` row, one
 * `llm-release-scan` row, one `current-tech-research-daily` row, and one
 * `task-quality-feedback-sample` row, and
 * that re-running the seeder is a no-op. The helper is covered in
 * `tests/hives/seed-schedules.test.ts`; this file asserts the same
 * invariants after a full HTTP POST through the Next.js route handler.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../_lib/test-db";
import { POST as createHive } from "@/app/api/hives/route";
import { seedDefaultSchedules } from "@/hives/seed-schedules";

const TEST_PREFIX = "p4-seed-";

beforeEach(async () => {
  await truncateAll(sql);
});

describe("POST /api/hives — default-schedule seeding", () => {
  it("seeds exactly one world-scan, supervisor heartbeat, ideas review, initiative evaluation, LLM release scan, current tech research, and task quality feedback schedule for a newly created hive", async () => {
    const slug = TEST_PREFIX + "new-hive";
    const req = new Request("http://localhost:3000/api/hives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Seed Co",
        slug,
        type: "digital",
        description: "A hive for schedule-seeding coverage",
      }),
    });
    const res = await createHive(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    const hiveId = body.data.id as string;
    expect(hiveId).toBeDefined();

    const rows = await sql<{
      cron_expression: string;
      enabled: boolean;
      task_template: Record<string, unknown>;
      created_by: string | null;
    }[]>`
      SELECT cron_expression, enabled, task_template, created_by
      FROM schedules WHERE hive_id = ${hiveId}::uuid
    `;
    expect(rows).toHaveLength(7);

    const worldScan = rows.find(
      (r) => (r.task_template as { title?: string }).title === "Daily world scan",
    );
    expect(worldScan).toBeDefined();
    expect(worldScan!.cron_expression).toBe("0 7 * * *");
    expect(worldScan!.enabled).toBe(true);
    expect(worldScan!.created_by).toBe("system:seed-default-schedules");
    const worldScanTemplate = worldScan!.task_template as {
      assignedTo: string;
      brief: string;
    };
    expect(worldScanTemplate.assignedTo).toBe("research-analyst");
    expect(worldScanTemplate.brief).toMatch(/Seed Co/);
    expect(worldScanTemplate.brief).toMatch(/schedule-seeding coverage/);

    const heartbeat = rows.find(
      (r) =>
        (r.task_template as { kind?: string }).kind ===
        "hive-supervisor-heartbeat",
    );
    expect(heartbeat).toBeDefined();
    expect(heartbeat!.cron_expression).toBe("*/15 * * * *");
    expect(heartbeat!.enabled).toBe(true);
    expect(heartbeat!.created_by).toBe("system:seed-default-schedules");
    const heartbeatTemplate = heartbeat!.task_template as {
      kind: string;
      assignedTo: string;
      title: string;
    };
    expect(heartbeatTemplate.kind).toBe("hive-supervisor-heartbeat");
    expect(heartbeatTemplate.assignedTo).toBe("hive-supervisor");
    expect(heartbeatTemplate.title).toBe("Hive supervisor heartbeat");

    const ideasReview = rows.find(
      (r) =>
        (r.task_template as { kind?: string }).kind ===
        "ideas-daily-review",
    );
    expect(ideasReview).toBeDefined();
    expect(ideasReview!.cron_expression).toBe("0 9 * * *");
    expect(ideasReview!.enabled).toBe(true);
    expect(ideasReview!.created_by).toBe("system:seed-default-schedules");
    const ideasReviewTemplate = ideasReview!.task_template as {
      kind: string;
      assignedTo: string;
      title: string;
    };
    expect(ideasReviewTemplate.kind).toBe("ideas-daily-review");
    expect(ideasReviewTemplate.assignedTo).toBe("ideas-curator");
    expect(ideasReviewTemplate.title).toBe("Ideas daily review");

    const initiativeEvaluation = rows.find(
      (r) =>
        (r.task_template as { kind?: string }).kind ===
        "initiative-evaluation",
    );
    expect(initiativeEvaluation).toBeDefined();
    expect(initiativeEvaluation!.cron_expression).toBe("0 * * * *");
    expect(initiativeEvaluation!.enabled).toBe(true);
    expect(initiativeEvaluation!.created_by).toBe("system:seed-default-schedules");
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

    const llmReleaseScan = rows.find(
      (r) =>
        (r.task_template as { kind?: string }).kind ===
        "llm-release-scan",
    );
    expect(llmReleaseScan).toBeDefined();
    expect(llmReleaseScan!.cron_expression).toBe("0 8 * * 1");
    expect(llmReleaseScan!.enabled).toBe(true);
    expect(llmReleaseScan!.created_by).toBe("system:seed-default-schedules");
    const llmReleaseScanTemplate = llmReleaseScan!.task_template as {
      kind: string;
      assignedTo: string;
      title: string;
      brief: string;
    };
    expect(llmReleaseScanTemplate.kind).toBe("llm-release-scan");
    expect(llmReleaseScanTemplate.assignedTo).toBe("initiative-engine");
    expect(llmReleaseScanTemplate.title).toBe("Weekly LLM release scan");
    expect(llmReleaseScanTemplate.brief).toBe("(populated at run time)");

    const currentTechResearch = rows.find(
      (r) =>
        (r.task_template as { kind?: string }).kind ===
        "current-tech-research-daily",
    );
    expect(currentTechResearch).toBeDefined();
    expect(currentTechResearch!.cron_expression).toBe("30 8 * * *");
    expect(currentTechResearch!.enabled).toBe(true);
    expect(currentTechResearch!.created_by).toBe("system:seed-default-schedules");
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
      (r) =>
        (r.task_template as { kind?: string }).kind ===
        "task-quality-feedback-sample",
    );
    expect(qualityFeedback).toBeDefined();
    expect(qualityFeedback!.cron_expression).toBe("0 10 * * *");
    expect(qualityFeedback!.enabled).toBe(true);
    expect(qualityFeedback!.created_by).toBe("system:seed-default-schedules");
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

    const [heartbeatCount] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${hiveId}::uuid
        AND task_template ->> 'kind' = 'hive-supervisor-heartbeat'
    `) as unknown as { c: number }[];
    expect(heartbeatCount.c).toBe(1);

    const [worldScanCount] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${hiveId}::uuid
        AND task_template ->> 'title' = 'Daily world scan'
    `) as unknown as { c: number }[];
    expect(worldScanCount.c).toBe(1);

    const [ideasReviewCount] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${hiveId}::uuid
        AND task_template ->> 'kind' = 'ideas-daily-review'
    `) as unknown as { c: number }[];
    expect(ideasReviewCount.c).toBe(1);

    const [initiativeEvaluationCount] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${hiveId}::uuid
        AND task_template ->> 'kind' = 'initiative-evaluation'
    `) as unknown as { c: number }[];
    expect(initiativeEvaluationCount.c).toBe(1);

    const [llmReleaseScanCount] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${hiveId}::uuid
        AND task_template ->> 'kind' = 'llm-release-scan'
    `) as unknown as { c: number }[];
    expect(llmReleaseScanCount.c).toBe(1);

    const [currentTechResearchCount] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${hiveId}::uuid
        AND task_template ->> 'kind' = 'current-tech-research-daily'
    `) as unknown as { c: number }[];
    expect(currentTechResearchCount.c).toBe(1);

    const [qualityFeedbackCount] = (await sql`
      SELECT COUNT(*)::int AS c FROM schedules
      WHERE hive_id = ${hiveId}::uuid
        AND task_template ->> 'kind' = 'task-quality-feedback-sample'
    `) as unknown as { c: number }[];
    expect(qualityFeedbackCount.c).toBe(1);
  });

  it("re-running seedDefaultSchedules against an API-created hive does not create duplicates", async () => {
    const slug = TEST_PREFIX + "idempotent-hive";
    const req = new Request("http://localhost:3000/api/hives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Idempotent Co",
        slug,
        type: "digital",
        description: null,
      }),
    });
    const res = await createHive(req);
    expect(res.status).toBe(201);
    const hiveId = (await res.json()).data.id as string;

    // Call the seeder a second time directly — this simulates the
    // migration-backfill path running against a hive whose API-creation
    // seed already ran. The invariant is: no duplicates.
    const second = await seedDefaultSchedules(sql, {
      id: hiveId,
      name: "Idempotent Co",
      description: null,
    });
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(7);

    const [{ total }] = (await sql`
      SELECT COUNT(*)::int AS total FROM schedules
      WHERE hive_id = ${hiveId}::uuid
    `) as unknown as { total: number }[];
    expect(total).toBe(7);

    const [{ hb }] = (await sql`
      SELECT COUNT(*)::int AS hb FROM schedules
      WHERE hive_id = ${hiveId}::uuid
        AND task_template ->> 'kind' = 'hive-supervisor-heartbeat'
    `) as unknown as { hb: number }[];
    expect(hb).toBe(1);

    const [{ ws }] = (await sql`
      SELECT COUNT(*)::int AS ws FROM schedules
      WHERE hive_id = ${hiveId}::uuid
        AND task_template ->> 'title' = 'Daily world scan'
    `) as unknown as { ws: number }[];
    expect(ws).toBe(1);

    const [{ ideas }] = (await sql`
      SELECT COUNT(*)::int AS ideas FROM schedules
      WHERE hive_id = ${hiveId}::uuid
        AND task_template ->> 'kind' = 'ideas-daily-review'
    `) as unknown as { ideas: number }[];
    expect(ideas).toBe(1);

    const [{ initiative }] = (await sql`
      SELECT COUNT(*)::int AS initiative FROM schedules
      WHERE hive_id = ${hiveId}::uuid
        AND task_template ->> 'kind' = 'initiative-evaluation'
    `) as unknown as { initiative: number }[];
    expect(initiative).toBe(1);

    const [{ llmReleaseScan }] = (await sql`
      SELECT COUNT(*)::int AS "llmReleaseScan" FROM schedules
      WHERE hive_id = ${hiveId}::uuid
        AND task_template ->> 'kind' = 'llm-release-scan'
    `) as unknown as { llmReleaseScan: number }[];
    expect(llmReleaseScan).toBe(1);

    const [{ currentTechResearch }] = (await sql`
      SELECT COUNT(*)::int AS "currentTechResearch" FROM schedules
      WHERE hive_id = ${hiveId}::uuid
        AND task_template ->> 'kind' = 'current-tech-research-daily'
    `) as unknown as { currentTechResearch: number }[];
    expect(currentTechResearch).toBe(1);

    const [{ qualityFeedback }] = (await sql`
      SELECT COUNT(*)::int AS "qualityFeedback" FROM schedules
      WHERE hive_id = ${hiveId}::uuid
        AND task_template ->> 'kind' = 'task-quality-feedback-sample'
    `) as unknown as { qualityFeedback: number }[];
    expect(qualityFeedback).toBe(1);
  });
});
