import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_OWNER_FEEDBACK_CONFIG,
  loadOwnerFeedbackSamplingConfig,
  saveOwnerFeedbackSamplingConfig,
  validateOwnerFeedbackSamplingPatch,
} from "@/quality/owner-feedback-config";
import { classifyQualityFeedbackLane } from "@/quality/feedback-lane-classifier";
import {
  findOwnerFeedbackSampleCandidates,
  runOwnerFeedbackSampleSweepForHive,
} from "@/quality/owner-feedback-sampler";
import { testSql as sql, truncateAll } from "../_lib/test-db";

const HIVE_A = "aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa";
const HIVE_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const NOW = new Date("2026-04-27T12:00:00.000Z");

async function seedTask(input: {
  id: string;
  hiveId?: string;
  role?: string;
  title?: string;
  completedAt?: string;
  retryCount?: number;
  resultSummary?: string | null;
  workProduct?: boolean;
  brief?: string;
}) {
  const hiveId = input.hiveId ?? HIVE_A;
  const taskId = input.id;
  const role = input.role ?? "dev-agent";

  await sql`
    INSERT INTO tasks (
      id, hive_id, assigned_to, created_by, status, priority,
      title, brief, result_summary, retry_count, completed_at
    )
    VALUES (
      ${taskId}, ${hiveId}, ${role}, 'test', 'completed', 5,
      ${input.title ?? `Task ${taskId}`},
      ${input.brief ?? "Brief with enough context for owner feedback sampling."},
      ${input.resultSummary ?? null},
      ${input.retryCount ?? 0},
      ${input.completedAt ?? "2026-04-26T12:00:00.000Z"}
    )
  `;

  if (input.workProduct) {
    await sql`
      INSERT INTO work_products (task_id, hive_id, role_slug, content, summary)
      VALUES (
        ${taskId}, ${hiveId}, ${role},
        'A concrete implementation artifact for the task.',
        'Concrete artifact summary.'
      )
    `;
  }
}

beforeEach(async () => {
  await truncateAll(sql);
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES
      (${HIVE_A}, 'feedback-a', 'Feedback A', 'digital'),
      (${HIVE_B}, 'feedback-b', 'Feedback B', 'digital')
  `;
  await sql`
    INSERT INTO role_templates (slug, name, type, adapter_type)
    VALUES
      ('dev-agent', 'Dev Agent', 'executor', 'claude-code'),
      ('qa-agent', 'QA Agent', 'executor', 'claude-code'),
      ('quality-reviewer', 'Quality Reviewer', 'executor', 'claude-code')
    ON CONFLICT (slug) DO NOTHING
  `;
});

describe("classifyQualityFeedbackLane", () => {
  it("routes canonical dashboard UI work to the owner lane", () => {
    expect(classifyQualityFeedbackLane({
      title: "Polish dashboard cards",
      brief: "Update src/app/(dashboard)/page.tsx and dashboard components.",
      roleSlug: "dev-agent",
      workProductSummary: "Dashboard UI now shows the honeycomb treatment.",
    }).lane).toBe("owner");
  });

  it("routes migrations, backend, and internal docs to the AI peer lane", () => {
    for (const input of [
      { title: "Add DB migration", brief: "Create drizzle migration for task_quality_signals.", roleSlug: "dev-agent" },
      { title: "Fix backend endpoint", brief: "Update API route handler auth.", roleSlug: "dev-agent" },
      { title: "Write internal handoff", brief: "Document repo coordinates and file map.", roleSlug: "research-analyst" },
    ]) {
      expect(classifyQualityFeedbackLane(input).lane).toBe("ai_peer");
    }
  });

  it("routes ambiguous work to the AI peer lane", () => {
    expect(classifyQualityFeedbackLane({
      title: "Establish baseline",
      brief: "Review current implementation and summarize.",
      roleSlug: "dev-agent",
    }).lane).toBe("ai_peer");
  });
});

describe("loadOwnerFeedbackSamplingConfig", () => {
  it("validates owner and AI peer sample rates as 0..1 values", () => {
    expect(validateOwnerFeedbackSamplingPatch({
      ownerFeedbackSampleRate: 0,
      aiPeerFeedbackSampleRate: 1,
    })).toEqual({
      ownerFeedbackSampleRate: 0,
      aiPeerFeedbackSampleRate: 1,
    });
    expect(validateOwnerFeedbackSamplingPatch({
      ownerFeedbackSampleRate: -0.01,
      aiPeerFeedbackSampleRate: 0.1,
    })).toEqual({
      error: "ownerFeedbackSampleRate and aiPeerFeedbackSampleRate must be numbers from 0 to 1",
    });
    expect(validateOwnerFeedbackSamplingPatch({
      ownerFeedbackSampleRate: 0.1,
      aiPeerFeedbackSampleRate: 1.01,
    })).toEqual({
      error: "ownerFeedbackSampleRate and aiPeerFeedbackSampleRate must be numbers from 0 to 1",
    });
  });

  it("returns documented defaults when no setting row exists", async () => {
    const config = await loadOwnerFeedbackSamplingConfig(sql, HIVE_A);
    expect(config).toEqual({
      sampleRate: DEFAULT_OWNER_FEEDBACK_CONFIG.owner_feedback_sample_rate,
      aiPeerReviewSampleRate: DEFAULT_OWNER_FEEDBACK_CONFIG.ai_peer_feedback_sample_rate,
      eligibilityWindowDays: DEFAULT_OWNER_FEEDBACK_CONFIG.owner_feedback_eligibility_window_days,
      duplicateCooldownDays: DEFAULT_OWNER_FEEDBACK_CONFIG.owner_feedback_duplicate_cooldown_days,
      perRoleDailyCap: DEFAULT_OWNER_FEEDBACK_CONFIG.owner_feedback_per_role_daily_cap,
      perDayCap: DEFAULT_OWNER_FEEDBACK_CONFIG.owner_feedback_per_day_cap,
    });
  });

  it("round-trips hive-scoped sample-rate overrides through the loader", async () => {
    await saveOwnerFeedbackSamplingConfig(sql, HIVE_A, {
      ownerFeedbackSampleRate: 0.2,
      aiPeerFeedbackSampleRate: 0.15,
    });

    const config = await loadOwnerFeedbackSamplingConfig(sql, HIVE_A);
    expect(config.sampleRate).toBe(0.2);
    expect(config.aiPeerReviewSampleRate).toBe(0.15);
    expect(config.eligibilityWindowDays).toBe(
      DEFAULT_OWNER_FEEDBACK_CONFIG.owner_feedback_eligibility_window_days,
    );

    await saveOwnerFeedbackSamplingConfig(sql, HIVE_A, {
      ownerFeedbackSampleRate: 0.12,
      aiPeerFeedbackSampleRate: 0.1,
    });

    const updated = await loadOwnerFeedbackSamplingConfig(sql, HIVE_A);
    expect(updated.sampleRate).toBe(0.12);
    expect(updated.aiPeerReviewSampleRate).toBe(0.1);
  });
});

describe("findOwnerFeedbackSampleCandidates", () => {
  it("filters by hive, completion recency, non-trivial evidence, retry count, and cooldown", async () => {
    await seedTask({ id: "10000000-0000-4000-8000-000000000001", workProduct: true });
    await seedTask({
      id: "10000000-0000-4000-8000-000000000002",
      resultSummary: "x".repeat(90),
    });
    await seedTask({
      id: "10000000-0000-4000-8000-000000000003",
      completedAt: "2026-04-01T12:00:00.000Z",
      workProduct: true,
    });
    await seedTask({
      id: "10000000-0000-4000-8000-000000000004",
      retryCount: 2,
      workProduct: true,
    });
    await seedTask({ id: "10000000-0000-4000-8000-000000000005" });
    await seedTask({
      id: "10000000-0000-4000-8000-000000000006",
      hiveId: HIVE_B,
      workProduct: true,
    });
    await sql`
      INSERT INTO decisions (hive_id, task_id, title, context, priority, status, kind)
      VALUES (
        ${HIVE_A},
        '10000000-0000-4000-8000-000000000002',
        'Task quality check: already sampled',
        'ctx',
        'normal',
        'resolved',
        'task_quality_feedback'
      )
    `;

    const candidates = await findOwnerFeedbackSampleCandidates(
      sql,
      HIVE_A,
      { eligibilityWindowDays: 7, duplicateCooldownDays: 30 },
      NOW,
    );

    expect(candidates.map((candidate) => candidate.taskId)).toEqual([
      "10000000-0000-4000-8000-000000000001",
    ]);
  });
});

describe("runOwnerFeedbackSampleSweepForHive", () => {
  it("uses deterministic random sampling and creates decision payloads with task, role, completion, and work-product metadata", async () => {
    await seedTask({
      id: "10000000-0000-4000-8000-000000000011",
      title: "Ship dashboard polish",
      workProduct: true,
    });
    await seedTask({
      id: "10000000-0000-4000-8000-000000000012",
      title: "Ship tasks UI polish",
      brief: "Update task list UI under src/app/(dashboard)/tasks.",
      workProduct: true,
    });

    const result = await runOwnerFeedbackSampleSweepForHive(sql, HIVE_A, {
      now: NOW,
      random: () => 0.01,
      config: {
        sampleRate: 1,
        aiPeerReviewSampleRate: 1,
        eligibilityWindowDays: 7,
        duplicateCooldownDays: 30,
        perRoleDailyCap: 1,
        perDayCap: 5,
      },
    });

    expect(result).toMatchObject({ eligible: 2, sampled: 2, decisionsCreated: 1 });
    const decisions = await sql<{
      task_id: string;
      title: string;
      context: string;
      recommendation: string;
      options: {
        kind: string;
        lane: string;
        responseModel: string;
        task: {
          id: string;
          role: string;
          completedAt: string;
          workProductId: string | null;
          workProductReference: string | null;
        };
        fields: Array<{ name: string; type: string; required: boolean }>;
      };
      status: string;
      kind: string;
    }[]>`
      SELECT task_id, title, context, recommendation, options, status, kind
      FROM decisions
      WHERE hive_id = ${HIVE_A} AND kind = 'task_quality_feedback'
    `;

    expect(decisions).toHaveLength(1);
    expect(decisions[0].status).toBe("pending");
    expect(decisions[0].title).toContain("Task quality check:");
    expect(decisions[0].context).toContain("Role: dev-agent");
    expect(decisions[0].context).toContain("Completed:");
    expect(decisions[0].context).toContain("Work product:");
    expect(decisions[0].recommendation).toContain("Rate this completed task from 1-10");
    expect(decisions[0].options.kind).toBe("task_quality_feedback");
    expect(decisions[0].options.lane).toBe("owner");
    expect(decisions[0].options.responseModel).toBe("quality_rating_v1");
    expect(decisions[0].options.task.role).toBe("dev-agent");
    expect(decisions[0].options.task.workProductReference).toContain("/tasks?taskId=");
    expect(decisions[0].options.fields).toEqual([
      { name: "rating", type: "integer", min: 1, max: 10, required: true },
      { name: "comment", type: "text", required: false },
    ]);
  });

  it("routes owner-evaluable samples to owner decisions and internal samples to AI peer review tasks", async () => {
    await seedTask({
      id: "10000000-0000-4000-8000-000000000041",
      title: "Ship dashboard UI update",
      brief: "Update src/app/(dashboard)/page.tsx.",
      workProduct: true,
    });
    await seedTask({
      id: "10000000-0000-4000-8000-000000000042",
      title: "Add DB migration for quality signals",
      brief: "Create a drizzle migration and backend API updates.",
      workProduct: true,
    });

    const result = await runOwnerFeedbackSampleSweepForHive(sql, HIVE_A, {
      now: NOW,
      random: () => 0,
      config: {
        sampleRate: 1,
        aiPeerReviewSampleRate: 1,
        eligibilityWindowDays: 7,
        duplicateCooldownDays: 30,
        perRoleDailyCap: 5,
        perDayCap: 5,
      },
    });

    expect(result).toMatchObject({
      decisionsCreated: 2,
      ownerDecisionsCreated: 1,
      aiPeerDecisionsCreated: 1,
      aiPeerReviewTasksCreated: 1,
    });

    const decisions = await sql<{ task_id: string; status: string; lane: string }[]>`
      SELECT task_id, status, options #>> '{lane}' AS lane
      FROM decisions
      WHERE hive_id = ${HIVE_A} AND kind = 'task_quality_feedback'
      ORDER BY task_id ASC
    `;
    expect(decisions).toEqual([
      { task_id: "10000000-0000-4000-8000-000000000041", status: "pending", lane: "owner" },
      { task_id: "10000000-0000-4000-8000-000000000042", status: "ea_review", lane: "ai_peer" },
    ]);

    const [reviewTask] = await sql<{ assigned_to: string; parent_task_id: string; brief: string }[]>`
      SELECT assigned_to, parent_task_id, brief
      FROM tasks
      WHERE assigned_to = 'quality-reviewer'
    `;
    expect(reviewTask.parent_task_id).toBe("10000000-0000-4000-8000-000000000042");
    expect(reviewTask.brief).toContain("/api/decisions/");
    expect(reviewTask.brief).toContain("task brief, work product, and agent session log");
  });

  it("reclassifies pending internal owner rows to AI peer review on the first sampler run", async () => {
    await seedTask({
      id: "10000000-0000-4000-8000-000000000051",
      title: "Establish frontend repo coordinates handoff",
      brief: "Write internal handoff docs and file map.",
      workProduct: true,
    });
    await sql`
      INSERT INTO decisions (hive_id, task_id, title, context, priority, status, kind, options)
      VALUES (
        ${HIVE_A},
        '10000000-0000-4000-8000-000000000051',
        'Task quality check: Establish frontend repo coordinates handoff',
        'ctx',
        'normal',
        'pending',
        'task_quality_feedback',
        ${sql.json({ kind: "task_quality_feedback", task: { role: "dev-agent" } })}
      )
    `;

    const result = await runOwnerFeedbackSampleSweepForHive(sql, HIVE_A, {
      now: NOW,
      random: () => 1,
      config: {
        sampleRate: 1,
        aiPeerReviewSampleRate: 1,
        eligibilityWindowDays: 7,
        duplicateCooldownDays: 30,
        perRoleDailyCap: 5,
        perDayCap: 5,
      },
    });

    expect(result.reclassifiedPending).toBe(1);
    const [decision] = await sql<{ status: string; lane: string }[]>`
      SELECT status, options #>> '{lane}' AS lane
      FROM decisions
      WHERE task_id = '10000000-0000-4000-8000-000000000051'
    `;
    expect(decision).toEqual({ status: "ea_review", lane: "ai_peer" });
  });

  it("enforces per-day caps and avoids duplicate active sample decisions", async () => {
    await seedTask({
      id: "10000000-0000-4000-8000-000000000021",
      title: "Ship dashboard UI polish",
      brief: "Update src/app/(dashboard)/page.tsx.",
      workProduct: true,
    });
    await seedTask({
      id: "10000000-0000-4000-8000-000000000022",
      role: "qa-agent",
      title: "Ship settings UI polish",
      brief: "Update settings UI copy.",
      workProduct: true,
    });

    const config = {
      sampleRate: 1,
      aiPeerReviewSampleRate: 1,
      eligibilityWindowDays: 7,
      duplicateCooldownDays: 30,
      perRoleDailyCap: 10,
      perDayCap: 1,
    };
    const first = await runOwnerFeedbackSampleSweepForHive(sql, HIVE_A, {
      now: NOW,
      random: () => 0,
      config,
    });
    await sql`
      UPDATE decisions
      SET created_at = ${NOW}
      WHERE hive_id = ${HIVE_A} AND kind = 'task_quality_feedback'
    `;
    const second = await runOwnerFeedbackSampleSweepForHive(sql, HIVE_A, {
      now: NOW,
      random: () => 0,
      config,
    });

    expect(first.decisionsCreated).toBe(1);
    expect(second.decisionsCreated).toBe(0);
    const [{ count }] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM decisions
      WHERE hive_id = ${HIVE_A} AND kind = 'task_quality_feedback'
    `;
    expect(count).toBe(1);
  });

  it("keeps hive scopes separate", async () => {
    await seedTask({
      id: "10000000-0000-4000-8000-000000000031",
      hiveId: HIVE_A,
      title: "Ship dashboard UI update",
      brief: "Update src/app/(dashboard)/page.tsx.",
      workProduct: true,
    });
    await seedTask({
      id: "10000000-0000-4000-8000-000000000032",
      hiveId: HIVE_B,
      title: "Ship dashboard UI update",
      brief: "Update src/app/(dashboard)/page.tsx.",
      workProduct: true,
    });

    await runOwnerFeedbackSampleSweepForHive(sql, HIVE_A, {
      now: NOW,
      random: () => 0,
      config: {
        sampleRate: 1,
        aiPeerReviewSampleRate: 1,
        eligibilityWindowDays: 7,
        duplicateCooldownDays: 30,
        perRoleDailyCap: 5,
        perDayCap: 5,
      },
    });

    const rows = await sql<{ hive_id: string; task_id: string }[]>`
      SELECT hive_id, task_id
      FROM decisions
      WHERE kind = 'task_quality_feedback'
    `;
    expect(rows).toEqual([
      { hive_id: HIVE_A, task_id: "10000000-0000-4000-8000-000000000031" },
    ]);
  });
});
