import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { testSql as sql, truncateAll } from "../../tests/_lib/test-db";
import { syncRoleLibrary } from "../roles/sync";
import { scanHive } from "./scan";

const HIVE_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_HIVE_ID = "11111111-1111-1111-1111-111111111112";

/**
 * Seeds the role_templates rows tasks.assigned_to references. These are the
 * roles exercised across the supervisor detector tests (consulting +
 * engineering + QA + doctor + supervisor itself). ON CONFLICT DO NOTHING
 * because role_templates is preserved across truncateAll().
 */
async function seedRoleTemplates() {
  const slugs: Array<[string, string, string]> = [
    ["design-agent", "Design Agent", "executor"],
    ["research-analyst", "Research Analyst", "executor"],
    ["data-analyst", "Data Analyst", "executor"],
    ["compliance-risk-analyst", "Compliance Risk Analyst", "executor"],
    ["intelligence-analyst", "Intelligence Analyst", "executor"],
    ["performance-analyst", "Performance Analyst", "executor"],
    ["financial-analyst", "Financial Analyst", "executor"],
    ["dev-agent", "Dev Agent", "executor"],
    ["infrastructure-agent", "Infrastructure Agent", "executor"],
    ["security-auditor", "Security Auditor", "executor"],
    ["qa", "QA", "system"],
    ["doctor", "Doctor", "system"],
    ["goal-supervisor", "Goal Supervisor", "system"],
    ["hive-supervisor", "Hive Supervisor", "system"],
  ];
  for (const [slug, name, type] of slugs) {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type)
      VALUES (${slug}, ${name}, ${type}, 'claude-code')
      ON CONFLICT (slug) DO NOTHING
    `;
  }
  // Reset terminal flag across the seeded set. truncateAll preserves
  // role_templates, and tests that assert terminal-role suppression toggle
  // this flag without cleanup — without this reset, pollution from a prior
  // run leaves design-agent/research-analyst terminal=true and the baseline
  // unsatisfied_completion cases stop firing on re-run.
  await sql`
    UPDATE role_templates
    SET terminal = false
    WHERE slug IN ${sql(slugs.map(([s]) => s))}
  `;
}

async function seedHive(id: string, slug: string) {
  await sql`
    INSERT INTO hives (id, slug, name, type)
    VALUES (${id}, ${slug}, ${slug}, 'digital')
  `;
}

beforeEach(async () => {
  await truncateAll(sql);
  await seedRoleTemplates();
  await seedHive(HIVE_ID, "test-hive");
});

describe.sequential("scanHive - skeleton + metrics", () => {
  it("returns empty findings + zeroed metrics for a fresh hive", async () => {
    const report = await scanHive(sql, HIVE_ID);
    expect(report.hiveId).toBe(HIVE_ID);
    expect(report.findings).toEqual([]);
    expect(report.metrics).toEqual({
      openTasks: 0,
      activeGoals: 0,
      openDecisions: 0,
      tasksCompleted24h: 0,
      tasksFailed24h: 0,
    });
    expect(typeof report.scannedAt).toBe("string");
    expect(() => new Date(report.scannedAt).toISOString()).not.toThrow();
  });

  it("findings are ordered by severity (critical before warn before info)", async () => {
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief, started_at, last_heartbeat, updated_at)
      VALUES
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01', ${HIVE_ID}, 'dev-agent', 'owner', 'active', 'warn-task', 'b',
         NOW() - interval '30 minutes', NOW() - interval '25 minutes', NOW() - interval '25 minutes'),
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa02', ${HIVE_ID}, 'dev-agent', 'owner', 'active', 'critical-task', 'b',
         NOW() - interval '4 hours', NOW() - interval '1 minute', NOW() - interval '1 minute')
    `;
    const report = await scanHive(sql, HIVE_ID);
    expect(report.findings.length).toBeGreaterThanOrEqual(2);
    const severities = report.findings.map((f) => f.severity);
    const criticalIdx = severities.indexOf("critical");
    const warnIdx = severities.indexOf("warn");
    expect(criticalIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeGreaterThanOrEqual(0);
    expect(criticalIdx).toBeLessThan(warnIdx);
  });

  it("counts only rows belonging to the target hive", async () => {
    await seedHive(OTHER_HIVE_ID, "other-hive");
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief)
      VALUES
        (${HIVE_ID}, 'dev-agent', 'owner', 'pending', 't1', 'b'),
        (${HIVE_ID}, 'dev-agent', 'owner', 'active', 't2', 'b'),
        (${OTHER_HIVE_ID}, 'dev-agent', 'owner', 'pending', 'other', 'b')
    `;
    await sql`
      INSERT INTO goals (hive_id, title, status)
      VALUES
        (${HIVE_ID}, 'g1', 'active'),
        (${HIVE_ID}, 'g2', 'archived'),
        (${OTHER_HIVE_ID}, 'other-goal', 'active')
    `;
    await sql`
      INSERT INTO decisions (hive_id, title, context, status)
      VALUES
        (${HIVE_ID}, 'd1', 'c', 'pending'),
        (${OTHER_HIVE_ID}, 'other-d', 'c', 'pending')
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, completed_at)
      VALUES (${HIVE_ID}, 'dev-agent', 'owner', 'completed', 'done', 'b', NOW() - interval '1 hour')
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, failure_reason, updated_at)
      VALUES (${HIVE_ID}, 'dev-agent', 'owner', 'failed', 'bad', 'b', 'boom', NOW() - interval '1 hour')
    `;

    const report = await scanHive(sql, HIVE_ID);
    expect(report.metrics).toEqual({
      openTasks: 2,
      activeGoals: 1,
      openDecisions: 1,
      tasksCompleted24h: 1,
      tasksFailed24h: 1,
    });
  });

  it("includes deterministic operating context for pause, queue, schedules, and model readiness", async () => {
    await sql`
      INSERT INTO hive_runtime_locks (
        hive_id, creation_paused, reason, paused_by, operating_state, schedule_snapshot
      )
      VALUES (
        ${HIVE_ID}, true, 'manual recovery', 'owner', 'paused',
        ${sql.json(["33333333-3333-4333-8333-333333333333"])}
      )
    `;
    await sql`
      INSERT INTO schedules (id, hive_id, cron_expression, task_template, enabled, created_by)
      VALUES (
        '33333333-3333-4333-8333-333333333333',
        ${HIVE_ID},
        '0 * * * *',
        ${sql.json({ assignedTo: "dev-agent", title: "digest", brief: "b" })},
        false,
        'owner'
      )
    `;
    await sql`
      INSERT INTO hive_models (hive_id, provider, adapter_type, model_id, enabled, fallback_priority)
      VALUES (${HIVE_ID}, 'example-provider', 'example-adapter', 'example-model', true, 1)
    `;

    const report = await scanHive(sql, HIVE_ID);
    const operatingContext = report.operatingContext;

    expect(operatingContext).toBeDefined();
    expect(operatingContext!.creationPause).toEqual({
      paused: true,
      reason: "manual recovery",
      pausedBy: "owner",
      operatingState: "paused",
      pausedScheduleIds: ["33333333-3333-4333-8333-333333333333"],
      updatedAt: expect.any(String),
    });
    expect(operatingContext!.resumeReadiness.status).toBe("blocked");
    expect(operatingContext!.resumeReadiness.counts).toMatchObject({
      enabledSchedules: 0,
      runnableTasks: 0,
      pendingDecisions: 0,
    });
    expect(operatingContext!.resumeReadiness.models).toMatchObject({
      enabled: 1,
      ready: 0,
      blocked: 1,
    });
    expect(operatingContext!.resumeReadiness.blockers.map((b) => b.code)).toContain(
      "model_health_blocked",
    );
  });

  it("includes target posture in the operating context", async () => {
    await sql`
      INSERT INTO hive_targets (id, hive_id, title, target_value, deadline, status, sort_order)
      VALUES
        ('44444444-4444-4444-8444-444444444441', ${HIVE_ID}, 'Reduce failed work', '0 failed tasks', CURRENT_DATE - 1, 'open', 0),
        ('44444444-4444-4444-8444-444444444442', ${HIVE_ID}, 'Ship setup flow', 'Done', CURRENT_DATE + 5, 'open', 1),
        ('44444444-4444-4444-8444-444444444443', ${HIVE_ID}, 'Old target', NULL, NULL, 'achieved', 2)
    `;

    const report = await scanHive(sql, HIVE_ID);

    expect(report.operatingContext?.targets).toMatchObject({
      open: 2,
      achieved: 1,
      abandoned: 0,
      overdueOpen: 1,
      dueSoonOpen: 1,
      openTargets: [
        {
          id: "44444444-4444-4444-8444-444444444441",
          title: "Reduce failed work",
          targetValue: "0 failed tasks",
          sortOrder: 0,
        },
        {
          id: "44444444-4444-4444-8444-444444444442",
          title: "Ship setup flow",
          targetValue: "Done",
          sortOrder: 1,
        },
      ],
    });
  });
});

describe.sequential("scanHive - stalled_task detector", () => {
  it("flags an active task with stale heartbeat (>20 min) as warn", async () => {
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief, started_at, last_heartbeat, updated_at)
      VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01', ${HIVE_ID}, 'dev-agent', 'owner', 'active', 'stale hb', 'b',
              NOW() - interval '25 minutes', NOW() - interval '25 minutes', NOW() - interval '25 minutes')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    const stalled = findings.filter((f) => f.kind === "stalled_task");
    expect(stalled).toHaveLength(1);
    expect(stalled[0].severity).toBe("warn");
    expect(stalled[0].ref.taskId).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01");
    expect(stalled[0].id).toContain("stalled_task:");
    expect(stalled[0].id).toContain("active");
  });

  it("flags an active task running longer than 3 hours as critical, even with fresh heartbeat", async () => {
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief, started_at, last_heartbeat, updated_at)
      VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb02', ${HIVE_ID}, 'dev-agent', 'owner', 'active', 'overrun', 'b',
              NOW() - interval '4 hours', NOW() - interval '30 seconds', NOW() - interval '30 seconds')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    const stalled = findings.filter((f) => f.kind === "stalled_task");
    expect(stalled).toHaveLength(1);
    expect(stalled[0].severity).toBe("critical");
  });

  it("flags an active task with null heartbeat + started_at > 20 min ago", async () => {
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief, started_at, last_heartbeat, updated_at)
      VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb03', ${HIVE_ID}, 'dev-agent', 'owner', 'active', 'no hb', 'b',
              NOW() - interval '25 minutes', NULL, NOW() - interval '25 minutes')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((f) => f.kind === "stalled_task")).toHaveLength(1);
  });

  it("does NOT flag an active task with a fresh heartbeat (<5 min)", async () => {
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief, started_at, last_heartbeat, updated_at)
      VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb04', ${HIVE_ID}, 'dev-agent', 'owner', 'active', 'healthy', 'b',
              NOW() - interval '25 minutes', NOW() - interval '1 minute', NOW() - interval '1 minute')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((f) => f.kind === "stalled_task")).toHaveLength(0);
  });

  it("does NOT flag an active task whose heartbeat is exactly 19 minutes old (boundary)", async () => {
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief, started_at, last_heartbeat, updated_at)
      VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb05', ${HIVE_ID}, 'dev-agent', 'owner', 'active', 'boundary-ok', 'b',
              NOW() - interval '30 minutes', NOW() - interval '19 minutes', NOW() - interval '19 minutes')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((f) => f.kind === "stalled_task")).toHaveLength(0);
  });

  it("flags a blocked task older than 6h with no active/pending child", async () => {
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief, updated_at)
      VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb06', ${HIVE_ID}, 'dev-agent', 'owner', 'blocked', 'old block', 'b',
              NOW() - interval '7 hours')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    const stalled = findings.filter((f) => f.kind === "stalled_task");
    expect(stalled).toHaveLength(1);
    expect(stalled[0].severity).toBe("warn");
    expect(stalled[0].id).toContain("blocked");
  });

  it("does NOT flag a blocked task with an in-flight pending child", async () => {
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief, updated_at)
      VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb07', ${HIVE_ID}, 'dev-agent', 'owner', 'blocked', 'parent', 'b',
              NOW() - interval '7 hours')
    `;
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, parent_task_id)
      VALUES (${HIVE_ID}, 'doctor', 'system', 'pending', 'child', 'b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb07')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((f) => f.kind === "stalled_task")).toHaveLength(0);
  });

  it("does NOT flag a blocked task that's only 5h old (under threshold)", async () => {
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief, updated_at)
      VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb08', ${HIVE_ID}, 'dev-agent', 'owner', 'blocked', 'young block', 'b',
              NOW() - interval '5 hours')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((f) => f.kind === "stalled_task")).toHaveLength(0);
  });

  it("does NOT flag a pending task (pending is NOT stalled before claim)", async () => {
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief, created_at, updated_at)
      VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb10', ${HIVE_ID}, 'dev-agent', 'owner', 'pending', 'queued', 'b',
              NOW() - interval '2 hours', NOW() - interval '2 hours')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((f) => f.kind === "stalled_task")).toHaveLength(0);
  });

  it("flags an in_review task older than 6h with no resolving child", async () => {
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief, updated_at)
      VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb09', ${HIVE_ID}, 'dev-agent', 'owner', 'in_review', 'old review', 'b',
              NOW() - interval '8 hours')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    const stalled = findings.filter((f) => f.kind === "stalled_task");
    expect(stalled).toHaveLength(1);
    expect(stalled[0].id).toContain("in_review");
  });
});

describe.sequential("scanHive - aging_decision detector", () => {
  it("flags an urgent pending decision older than 4h with no recent message", async () => {
    await sql`
      INSERT INTO decisions (id, hive_id, title, context, status, priority, created_at)
      VALUES ('cccccccc-cccc-cccc-cccc-cccccccccc01', ${HIVE_ID}, 'urgent-1', 'ctx', 'pending', 'urgent',
              NOW() - interval '5 hours')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    const aging = findings.filter((f) => f.kind === "aging_decision");
    expect(aging).toHaveLength(1);
    expect(aging[0].severity).toBe("warn");
    expect(aging[0].ref.decisionId).toBe("cccccccc-cccc-cccc-cccc-cccccccccc01");
    expect(aging[0].id).toBe("aging_decision:cccccccc-cccc-cccc-cccc-cccccccccc01");
  });

  it("flags a non-urgent pending decision older than 24h with no recent message", async () => {
    await sql`
      INSERT INTO decisions (id, hive_id, title, context, status, priority, created_at)
      VALUES ('cccccccc-cccc-cccc-cccc-cccccccccc02', ${HIVE_ID}, 'normal-1', 'ctx', 'pending', 'normal',
              NOW() - interval '25 hours')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    const aging = findings.filter((f) => f.kind === "aging_decision");
    expect(aging).toHaveLength(1);
    expect(aging[0].severity).toBe("warn");
  });

  it("escalates severity to critical past 72h regardless of priority", async () => {
    await sql`
      INSERT INTO decisions (id, hive_id, title, context, status, priority, created_at)
      VALUES ('cccccccc-cccc-cccc-cccc-cccccccccc03', ${HIVE_ID}, 'ancient', 'ctx', 'pending', 'normal',
              NOW() - interval '4 days')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    const aging = findings.filter((f) => f.kind === "aging_decision");
    expect(aging).toHaveLength(1);
    expect(aging[0].severity).toBe("critical");
  });

  it("does NOT flag an urgent decision newer than 4h (boundary)", async () => {
    await sql`
      INSERT INTO decisions (id, hive_id, title, context, status, priority, created_at)
      VALUES ('cccccccc-cccc-cccc-cccc-cccccccccc04', ${HIVE_ID}, 'fresh urgent', 'ctx', 'pending', 'urgent',
              NOW() - interval '3 hours 50 minutes')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((f) => f.kind === "aging_decision")).toHaveLength(0);
  });

  it("does NOT flag a decision with a recent decision_message", async () => {
    await sql`
      INSERT INTO decisions (id, hive_id, title, context, status, priority, created_at)
      VALUES ('cccccccc-cccc-cccc-cccc-cccccccccc05', ${HIVE_ID}, 'chatting', 'ctx', 'pending', 'urgent',
              NOW() - interval '5 hours')
    `;
    await sql`
      INSERT INTO decision_messages (decision_id, sender, content, created_at)
      VALUES ('cccccccc-cccc-cccc-cccc-cccccccccc05', 'owner', 'thinking about it', NOW() - interval '10 minutes')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((f) => f.kind === "aging_decision")).toHaveLength(0);
  });

  it("does NOT flag a decision already in ea_review or resolved", async () => {
    await sql`
      INSERT INTO decisions (id, hive_id, title, context, status, priority, created_at)
      VALUES
        ('cccccccc-cccc-cccc-cccc-cccccccccc06', ${HIVE_ID}, 'ea-reviewing', 'ctx', 'ea_review', 'urgent',
         NOW() - interval '5 hours'),
        ('cccccccc-cccc-cccc-cccc-cccccccccc07', ${HIVE_ID}, 'old-done', 'ctx', 'resolved', 'urgent',
         NOW() - interval '5 hours')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((f) => f.kind === "aging_decision")).toHaveLength(0);
  });

  it("does NOT flag a pending decision whose owner_response is already set", async () => {
    await sql`
      INSERT INTO decisions (id, hive_id, title, context, status, priority, created_at, owner_response)
      VALUES ('cccccccc-cccc-cccc-cccc-cccccccccc08', ${HIVE_ID}, 'answered', 'ctx', 'pending', 'urgent',
              NOW() - interval '5 hours', 'yes')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((f) => f.kind === "aging_decision")).toHaveLength(0);
  });
});

describe.sequential("scanHive - recurring_failure detector", () => {
  async function insertFailure(
    id: string,
    role: string,
    reason: string,
    ageHours = 1,
    opts: { status?: string; title?: string } = {},
  ) {
    const status = opts.status ?? "failed";
    const title = opts.title ?? "task";
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief, failure_reason, created_at, updated_at)
      VALUES (${id}, ${HIVE_ID}, ${role}, 'owner', ${status}, ${title}, 'b', ${reason},
              NOW() - (${ageHours}::float || ' hours')::interval,
              NOW() - (${ageHours}::float || ' hours')::interval)
    `;
  }

  it("flags >=3 failures in the same role+signature within 24h as critical", async () => {
    await insertFailure("dddddddd-dddd-dddd-dddd-dddddddddd01", "dev-agent", "ECONNREFUSED: Ollama at 192.168.1.10:11434");
    await insertFailure("dddddddd-dddd-dddd-dddd-dddddddddd02", "dev-agent", "ECONNREFUSED: Ollama at 192.168.1.10:11434", 2);
    await insertFailure("dddddddd-dddd-dddd-dddd-dddddddddd03", "dev-agent", "ECONNREFUSED: Ollama at 192.168.1.10:11434", 3);
    const { findings } = await scanHive(sql, HIVE_ID);
    const rec = findings.filter((f) => f.kind === "recurring_failure");
    expect(rec).toHaveLength(1);
    expect(rec[0].severity).toBe("critical");
    expect(rec[0].ref.role).toBe("dev-agent");
    expect(rec[0].id).toMatch(/^recurring_failure:dev-agent:/);
    expect(rec[0].detail.count).toBe(3);
    expect((rec[0].detail.taskIds as string[])).toHaveLength(3);
  });

  it("normalizes UUIDs, numbers, and quoted strings so near-identical reasons cluster", async () => {
    await insertFailure(
      "dddddddd-dddd-dddd-dddd-dddddddddd04",
      "dev-agent",
      'Adapter timeout for task 11111111-2222-3333-4444-555555555555 after 12000ms',
    );
    await insertFailure(
      "dddddddd-dddd-dddd-dddd-dddddddddd05",
      "dev-agent",
      'Adapter timeout for task 99999999-8888-7777-6666-555555555555 after 13500ms',
      2,
    );
    await insertFailure(
      "dddddddd-dddd-dddd-dddd-dddddddddd06",
      "dev-agent",
      'Adapter timeout for task aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee after 9800ms',
      3,
    );
    const { findings } = await scanHive(sql, HIVE_ID);
    const rec = findings.filter((f) => f.kind === "recurring_failure");
    expect(rec).toHaveLength(1);
    expect(rec[0].detail.count).toBe(3);
  });

  it("does NOT flag just 2 failures (below threshold of 3)", async () => {
    await insertFailure("dddddddd-dddd-dddd-dddd-dddddddddd07", "dev-agent", "QA retry cap exceeded");
    await insertFailure("dddddddd-dddd-dddd-dddd-dddddddddd08", "dev-agent", "QA retry cap exceeded", 2);
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((f) => f.kind === "recurring_failure")).toHaveLength(0);
  });

  it("does NOT count failures older than 24h", async () => {
    await insertFailure("dddddddd-dddd-dddd-dddd-dddddddddd09", "dev-agent", "stale error", 25);
    await insertFailure("dddddddd-dddd-dddd-dddd-dddddddddd0a", "dev-agent", "stale error", 30);
    await insertFailure("dddddddd-dddd-dddd-dddd-dddddddddd0b", "dev-agent", "stale error", 35);
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((f) => f.kind === "recurring_failure")).toHaveLength(0);
  });

  it("excludes doctor-role failures and [Doctor] Diagnose: titled downstream tasks", async () => {
    await insertFailure("dddddddd-dddd-dddd-dddd-dddddddddd0c", "doctor", "Unknown agent id \"hw-doctor\"");
    await insertFailure("dddddddd-dddd-dddd-dddd-dddddddddd0d", "doctor", "Unknown agent id \"hw-doctor\"", 2);
    await insertFailure("dddddddd-dddd-dddd-dddd-dddddddddd0e", "doctor", "Unknown agent id \"hw-doctor\"", 3);
    await insertFailure(
      "dddddddd-dddd-dddd-dddd-dddddddddd0f",
      "dev-agent",
      "Unknown agent id \"hw-doctor\"",
      1,
      { title: "[Doctor] Diagnose: something" },
    );
    await insertFailure(
      "dddddddd-dddd-dddd-dddd-dddddddddd10",
      "dev-agent",
      "Unknown agent id \"hw-doctor\"",
      2,
      { title: "[Doctor] Diagnose: something" },
    );
    await insertFailure(
      "dddddddd-dddd-dddd-dddd-dddddddddd11",
      "dev-agent",
      "Unknown agent id \"hw-doctor\"",
      3,
      { title: "[Doctor] Diagnose: something" },
    );
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((f) => f.kind === "recurring_failure")).toHaveLength(0);
  });

  it("counts mixed failed+unresolvable statuses together", async () => {
    await insertFailure("dddddddd-dddd-dddd-dddd-dddddddddd12", "dev-agent", "missing dep foo");
    await insertFailure("dddddddd-dddd-dddd-dddd-dddddddddd13", "dev-agent", "missing dep foo", 2, { status: "unresolvable" });
    await insertFailure("dddddddd-dddd-dddd-dddd-dddddddddd14", "dev-agent", "missing dep foo", 3);
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((f) => f.kind === "recurring_failure")).toHaveLength(1);
  });

  it("adds codex empty-output flags to recurring_failure detail from diagnostic task_logs", async () => {
    const taskIds = [
      "dddddddd-dddd-dddd-dddd-dddddddddd15",
      "dddddddd-dddd-dddd-dddd-dddddddddd16",
      "dddddddd-dddd-dddd-dddd-dddddddddd17",
    ];
    for (const [index, taskId] of taskIds.entries()) {
      await insertFailure(taskId, "dev-agent", "Codex exited code 1: codex reported error", index + 1);
      await sql`
        INSERT INTO task_logs (task_id, type, chunk)
        VALUES (${taskId}, 'diagnostic', ${JSON.stringify({
          kind: "codex_empty_output",
          schemaVersion: 1,
          codexEmptyOutput: true,
          rolloutSignaturePresent: index !== 2,
          exitCode: 1,
          effectiveAdapter: "codex",
          adapterOverride: index === 1 ? "codex" : null,
          modelSlug: index === 2 ? "anthropic/claude-opus-4-7" : "openai-codex/gpt-5.5",
          modelProviderMismatchDetected: index === 2,
          cwd: "/workspace/hivewrightv2",
          stderrTail: "failed to record rollout items",
          truncated: false,
        })})
      `;
    }

    const { findings } = await scanHive(sql, HIVE_ID);
    const [rec] = findings.filter((f) => f.kind === "recurring_failure");

    expect(rec.detail.codexEmptyOutput).toBe(true);
    expect(rec.detail.rolloutSignaturePresent).toBe(true);
    expect(rec.detail.diagnosticTaskIds).toEqual(taskIds);
    expect(rec.detail.diagnosticEffectiveAdapters).toEqual(["codex"]);
    expect(rec.detail.diagnosticAdapterOverrides).toEqual(["codex"]);
    expect(rec.detail.diagnosticModels).toEqual([
      "anthropic/claude-opus-4-7",
      "openai-codex/gpt-5.5",
    ]);
    expect(rec.detail.modelProviderMismatchDetected).toBe(true);
  });
});

describe.sequential("scanHive - unsatisfied_completion detector", () => {
  async function insertCompletedTask(
    id: string,
    opts: {
      assignedTo?: string;
      title?: string;
      brief?: string;
      goalId?: string | null;
      resultSummary?: string | null;
      completedHoursAgo?: number;
    } = {},
  ) {
    const assignedTo = opts.assignedTo ?? "design-agent";
    const title = opts.title ?? "advisory";
    const brief = opts.brief ?? "b";
    const goalId = opts.goalId ?? null;
    const resultSummary = opts.resultSummary ?? null;
    const age = opts.completedHoursAgo ?? 1;
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief,
                         goal_id, result_summary, completed_at, created_at, updated_at)
      VALUES (${id}, ${HIVE_ID}, ${assignedTo}, 'owner', 'completed', ${title}, ${brief},
              ${goalId}, ${resultSummary},
              NOW() - (${age}::float || ' hours')::interval,
              NOW() - (${age}::float || ' hours')::interval,
              NOW() - (${age}::float || ' hours')::interval)
    `;
  }

  it("flags a completed direct task with substantive result_summary and no follow-up", async () => {
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01", {
      resultSummary: "x".repeat(250),
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    const f = findings.filter((x) => x.kind === "unsatisfied_completion");
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("warn");
    expect(f[0].ref.taskId).toBe("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01");
    expect(f[0].id).toBe(
      "unsatisfied_completion:eeeeeeee-eeee-eeee-eeee-eeeeeeeeee01",
    );
  });

  it("flags a completed direct task with a linked work_product and no follow-up", async () => {
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee02");
    await sql`
      INSERT INTO work_products (task_id, hive_id, role_slug, content)
      VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee02', ${HIVE_ID}, 'design-agent', 'substantive output')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(1);
  });

  it("does NOT flag a completed task with a thin result_summary and no work_product", async () => {
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee03", {
      resultSummary: "done",
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(0);
  });

  it("does NOT flag a completed task whose completed_at is newer than 30 minutes", async () => {
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief, result_summary,
                         completed_at, created_at, updated_at)
      VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee04', ${HIVE_ID}, 'design-agent', 'owner', 'completed',
              'fresh', 'b', ${"x".repeat(250)},
              NOW() - interval '20 minutes',
              NOW() - interval '20 minutes',
              NOW() - interval '20 minutes')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(0);
  });

  it("does NOT flag QA, doctor, or goal-supervisor completions", async () => {
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee05", {
      assignedTo: "qa",
      resultSummary: "x".repeat(250),
    });
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee06", {
      assignedTo: "doctor",
      resultSummary: "x".repeat(250),
    });
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee07", {
      assignedTo: "goal-supervisor",
      resultSummary: "x".repeat(250),
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(0);
  });

  it("does NOT flag a completed task whose goal_id is set (goal supervisor owns continuation)", async () => {
    await sql`
      INSERT INTO goals (id, hive_id, title, status)
      VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeee0001', ${HIVE_ID}, 'g', 'active')
    `;
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee08", {
      goalId: "eeeeeeee-eeee-eeee-eeee-eeeeeeee0001",
      resultSummary: "x".repeat(250),
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(0);
  });

  it("does NOT flag a completed task that already spawned a child task", async () => {
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee09", {
      resultSummary: "x".repeat(250),
    });
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, parent_task_id)
      VALUES (${HIVE_ID}, 'dev-agent', 'system', 'pending', 'child', 'b',
              'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee09')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(0);
  });

  it("does NOT flag a completed task that already produced a linked decision", async () => {
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee0a", {
      resultSummary: "x".repeat(250),
    });
    await sql`
      INSERT INTO decisions (hive_id, title, context, status, task_id)
      VALUES (${HIVE_ID}, 'follow-up', 'c', 'pending', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee0a')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(0);
  });

  // Boundary: completed_at age threshold is `< NOW() - interval '30 minutes'`.
  // 31m-ago is clearly past the threshold; 29m-ago is clearly short of it.
  it("boundary: flags a task completed 31 minutes ago (just past 30m threshold)", async () => {
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee0b", {
      resultSummary: "x".repeat(250),
      completedHoursAgo: 31 / 60,
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(1);
  });

  it("boundary: does NOT flag a task completed 29 minutes ago (just short of 30m threshold)", async () => {
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee0c", {
      resultSummary: "x".repeat(250),
      completedHoursAgo: 29 / 60,
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(0);
  });

  // Boundary: result_summary length threshold is `>= 200` chars. With no
  // work_product attached, the summary length is the sole signal of
  // substantive output — the 199/200 edge directly drives detector firing.
  it("boundary: flags a task with result_summary exactly 200 chars and no work_product", async () => {
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee0d", {
      resultSummary: "x".repeat(200),
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    const f = findings.filter((x) => x.kind === "unsatisfied_completion");
    expect(f).toHaveLength(1);
    expect(f[0].detail.hasWorkProduct).toBe(false);
    expect(f[0].detail.resultSummaryLength).toBe(200);
  });

  it("boundary: does NOT flag a task with result_summary exactly 199 chars and no work_product", async () => {
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee0e", {
      resultSummary: "x".repeat(199),
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(0);
  });

  // Integrity-violation path: a `completed` row with non-null failure_reason
  // is the shape we observed on goal 168360bb (task 6de38eb2 marked completed
  // after the adapter hit "Reached maximum turn limit"). The detector must
  // surface these regardless of the old goal/age/output-thickness filters —
  // the failure_reason itself is the signal.
  async function insertCompletedWithFailure(
    id: string,
    opts: {
      assignedTo?: string;
      title?: string;
      goalId?: string | null;
      resultSummary?: string | null;
      failureReason?: string | null;
      completedHoursAgo?: number;
      status?: string;
    } = {},
  ) {
    const assignedTo = opts.assignedTo ?? "dev-agent";
    const title = opts.title ?? "limit-hit";
    const goalId = opts.goalId ?? null;
    const resultSummary = opts.resultSummary ?? null;
    const failureReason =
      opts.failureReason === undefined
        ? "Reached maximum turn limit. Task likely needs decomposition..."
        : opts.failureReason;
    const age = opts.completedHoursAgo ?? 1;
    const status = opts.status ?? "completed";
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief,
                         goal_id, result_summary, failure_reason,
                         completed_at, created_at, updated_at)
      VALUES (${id}, ${HIVE_ID}, ${assignedTo}, 'owner', ${status}, ${title}, 'b',
              ${goalId}, ${resultSummary}, ${failureReason},
              NOW() - (${age}::float || ' hours')::interval,
              NOW() - (${age}::float || ' hours')::interval,
              NOW() - (${age}::float || ' hours')::interval)
    `;
  }

  it("flags a completed task with non-null failure_reason even when goal-owned (primary integrity violation)", async () => {
    await sql`
      INSERT INTO goals (id, hive_id, title, status)
      VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeee0168', ${HIVE_ID}, 'g-168360bb', 'active')
    `;
    await insertCompletedWithFailure("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeef1", {
      goalId: "eeeeeeee-eeee-eeee-eeee-eeeeeeee0168",
      resultSummary: "short",
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    const f = findings.filter((x) => x.kind === "unsatisfied_completion");
    expect(f).toHaveLength(1);
    expect(f[0].ref.taskId).toBe("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeef1");
    expect(f[0].severity).toBe("warn");
    expect(f[0].detail.failureReason).toBe(
      "Reached maximum turn limit. Task likely needs decomposition...",
    );
    expect(f[0].id).toBe(
      "unsatisfied_completion:eeeeeeee-eeee-eeee-eeee-eeeeeeeeeef1",
    );
  });

  it("flags a completed task with failure_reason even if summary is thin and no work_product (failure_reason is the signal)", async () => {
    await insertCompletedWithFailure("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeef2", {
      resultSummary: "done",
      failureReason: "Adapter wrapped up after hitting timeout",
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(1);
  });

  it("flags a completed task with failure_reason completed <30 minutes ago (integrity signal does not wait for the age gate)", async () => {
    await insertCompletedWithFailure("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeef3", {
      completedHoursAgo: 5 / 60,
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(1);
  });

  it("does NOT flag a completed task with null failure_reason (null is the success signal)", async () => {
    await insertCompletedWithFailure("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeef4", {
      failureReason: null,
      resultSummary: "ok",
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(0);
  });

  it("does NOT flag a completed task with failure_reason when role is doctor/qa/goal-supervisor (terminal roles suppressed)", async () => {
    await insertCompletedWithFailure("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeef5", {
      assignedTo: "doctor",
    });
    await insertCompletedWithFailure("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeef6", {
      assignedTo: "qa",
    });
    await insertCompletedWithFailure("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeef7", {
      assignedTo: "goal-supervisor",
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(0);
  });

  it("does NOT flag a completed task with failure_reason when a follow-up child already exists (already remediated)", async () => {
    await insertCompletedWithFailure("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeef8");
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, parent_task_id)
      VALUES (${HIVE_ID}, 'dev-agent', 'system', 'pending', 'followup', 'b',
              'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeef8')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(0);
  });

  it("does NOT flag a non-completed terminal row with failure_reason (only status='completed' is the integrity violation shape)", async () => {
    await insertCompletedWithFailure("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeef9", {
      status: "cancelled",
    });
    await insertCompletedWithFailure("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeefa", {
      status: "failed",
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(0);
  });

  // Terminal-role suppression: 2026-04-22 self-scan loop fix. Heartbeat,
  // analysis-only, and watchdog roles mark role_templates.terminal=true
  // so their completions never trip unsatisfied_completion. Separate from
  // the qa/doctor/goal-supervisor hardcoded set.
  it("does NOT flag a hive-supervisor heartbeat completion (hardcoded exclusion — self-scan is nonsensical)", async () => {
    await sql`UPDATE role_templates SET terminal = false WHERE slug = 'hive-supervisor'`;
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee10", {
      assignedTo: "hive-supervisor",
      resultSummary: "x".repeat(250),
    });
    await insertCompletedWithFailure("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee11", {
      assignedTo: "hive-supervisor",
      failureReason: "adapter turn limit",
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(0);
  });

  it("does NOT flag completions from terminal roles (design-agent commentary, research-analyst analysis)", async () => {
    await sql`UPDATE role_templates SET terminal = true WHERE slug IN ('design-agent', 'research-analyst')`;
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee12", {
      assignedTo: "design-agent",
      resultSummary: "x".repeat(250),
    });
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee13", {
      assignedTo: "research-analyst",
      resultSummary: "x".repeat(300),
    });
    // Control: a non-terminal role with identical shape still fires.
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee14", {
      assignedTo: "dev-agent",
      resultSummary: "x".repeat(250),
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    const f = findings.filter((x) => x.kind === "unsatisfied_completion");
    expect(f).toHaveLength(1);
    expect(f[0].ref.taskId).toBe("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee14");
  });

  it("does NOT flag failure_reason integrity-path completions when the role is terminal", async () => {
    await sql`UPDATE role_templates SET terminal = true WHERE slug = 'research-analyst'`;
    await insertCompletedWithFailure("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee15", {
      assignedTo: "research-analyst",
      failureReason: "Reached maximum turn limit...",
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(0);
  });

  it("does NOT flag proof-only terminal verification tasks for dev-agent", async () => {
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee16", {
      assignedTo: "dev-agent",
      title: "Plan 4 smoke test",
      brief:
        "Print the text `smoke test running`, then exit. Do not modify any files or run any other commands.",
      resultSummary: "x".repeat(250),
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(0);
  });

  it("does NOT flag proof-only verification inventory tasks for security-auditor", async () => {
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee17", {
      assignedTo: "security-auditor",
      title: "Verify auth coverage: remaining goal mutation handlers",
      brief:
        "Audit those handlers and confirm coverage. Produce a concise implementation checklist with exact file paths. Do not modify application code.",
      resultSummary: "x".repeat(250),
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(
      findings.filter((x) => x.kind === "unsatisfied_completion"),
    ).toHaveLength(0);
  });

  it("still flags verification tasks that may need implementation or a commit", async () => {
    await insertCompletedTask("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee18", {
      assignedTo: "dev-agent",
      title: "Verify codex.ts check() fix is committed and build is clean",
      brief:
        "If NOT committed: apply the minimal fix in src/provisioning/codex.ts, then commit it and rerun build.",
      resultSummary: "x".repeat(250),
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    const unsat = findings.filter((x) => x.kind === "unsatisfied_completion");
    expect(unsat).toHaveLength(1);
    expect(unsat[0].ref.taskId).toBe("eeeeeeee-eeee-eeee-eeee-eeeeeeeeee18");
  });
});

describe.sequential("scanHive - dormant_goal detector", () => {
  async function insertGoal(
    id: string,
    opts: {
      status?: string;
      updatedHoursAgo?: number;
      createdHoursAgo?: number;
      sessionId?: string | null;
    } = {},
  ) {
    const status = opts.status ?? "active";
    const updated = opts.updatedHoursAgo ?? 48;
    const created = opts.createdHoursAgo ?? updated;
    const sessionId = opts.sessionId ?? "sess-1";
    await sql`
      INSERT INTO goals (id, hive_id, title, status, session_id, created_at, updated_at)
      VALUES (${id}, ${HIVE_ID}, 'g', ${status}, ${sessionId},
              NOW() - (${created}::float || ' hours')::interval,
              NOW() - (${updated}::float || ' hours')::interval)
    `;
  }

  it("flags an active goal with no open tasks and no activity in 24h", async () => {
    await insertGoal("ffffffff-ffff-ffff-ffff-ffffffffff01", {
      updatedHoursAgo: 48,
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    const f = findings.filter((x) => x.kind === "dormant_goal");
    expect(f).toHaveLength(1);
    expect(f[0].ref.goalId).toBe("ffffffff-ffff-ffff-ffff-ffffffffff01");
    expect(f[0].id).toBe("dormant_goal:ffffffff-ffff-ffff-ffff-ffffffffff01");
    expect(f[0].severity).toBe("warn");
  });

  it("does NOT flag a goal with an open (pending/active) task", async () => {
    await insertGoal("ffffffff-ffff-ffff-ffff-ffffffffff02", {
      updatedHoursAgo: 48,
    });
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, goal_id, updated_at)
      VALUES (${HIVE_ID}, 'dev-agent', 'owner', 'pending', 't', 'b',
              'ffffffff-ffff-ffff-ffff-ffffffffff02', NOW() - interval '48 hours')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((x) => x.kind === "dormant_goal")).toHaveLength(0);
  });

  it("does NOT flag a goal whose latest task updated within 24h", async () => {
    await insertGoal("ffffffff-ffff-ffff-ffff-ffffffffff03", {
      updatedHoursAgo: 48,
    });
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, goal_id,
                         completed_at, created_at, updated_at)
      VALUES (${HIVE_ID}, 'dev-agent', 'owner', 'completed', 't', 'b',
              'ffffffff-ffff-ffff-ffff-ffffffffff03',
              NOW() - interval '2 hours',
              NOW() - interval '48 hours',
              NOW() - interval '2 hours')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((x) => x.kind === "dormant_goal")).toHaveLength(0);
  });

  it("does NOT flag a goal with a recent goal_comment", async () => {
    await insertGoal("ffffffff-ffff-ffff-ffff-ffffffffff04", {
      updatedHoursAgo: 48,
    });
    await sql`
      INSERT INTO goal_comments (goal_id, body, created_by, created_at)
      VALUES ('ffffffff-ffff-ffff-ffff-ffffffffff04', 'ping', 'owner', NOW() - interval '1 hour')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((x) => x.kind === "dormant_goal")).toHaveLength(0);
  });

  it("does NOT flag a goal with a recent goal_document update", async () => {
    await insertGoal("ffffffff-ffff-ffff-ffff-ffffffffff05", {
      updatedHoursAgo: 48,
    });
    await sql`
      INSERT INTO goal_documents (goal_id, document_type, title, body, created_by, created_at, updated_at)
      VALUES ('ffffffff-ffff-ffff-ffff-ffffffffff05', 'plan', 'p', 'b', 'goal-supervisor',
              NOW() - interval '48 hours', NOW() - interval '1 hour')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((x) => x.kind === "dormant_goal")).toHaveLength(0);
  });

  it("does NOT flag archived or non-active goals", async () => {
    await insertGoal("ffffffff-ffff-ffff-ffff-ffffffffff06", {
      status: "archived",
      updatedHoursAgo: 72,
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((x) => x.kind === "dormant_goal")).toHaveLength(0);
  });

  it("does NOT flag a newly-created goal (<1h) with null session_id (goal startup state)", async () => {
    await insertGoal("ffffffff-ffff-ffff-ffff-ffffffffff07", {
      status: "active",
      updatedHoursAgo: 0.3,
      createdHoursAgo: 0.3,
      sessionId: null,
    });
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((x) => x.kind === "dormant_goal")).toHaveLength(0);
  });
});

describe.sequential("scanHive - goal_lifecycle_gap detector", () => {
  async function insertGoal(
    id: string,
    opts: {
      status?: string;
      updatedHoursAgo?: number;
      createdHoursAgo?: number;
      sessionId?: string | null;
    } = {},
  ) {
    const status = opts.status ?? "active";
    const updated = opts.updatedHoursAgo ?? 2;
    const created = opts.createdHoursAgo ?? updated;
    const sessionId = opts.sessionId ?? "sess-1";
    await sql`
      INSERT INTO goals (id, hive_id, title, status, session_id, created_at, updated_at)
      VALUES (${id}, ${HIVE_ID}, 'lifecycle gap goal', ${status}, ${sessionId},
              NOW() - (${created}::float || ' hours')::interval,
              NOW() - (${updated}::float || ' hours')::interval)
    `;
  }

  it("flags an active goal with zero tasks after the startup window", async () => {
    await insertGoal("ffffffff-ffff-ffff-ffff-ffffffffff08", {
      updatedHoursAgo: 2,
      createdHoursAgo: 2,
    });

    const { findings } = await scanHive(sql, HIVE_ID);
    const f = findings.filter((x) => x.kind === "goal_lifecycle_gap");

    expect(f).toHaveLength(1);
    expect(f[0].id).toBe("goal_lifecycle_gap:ffffffff-ffff-ffff-ffff-ffffffffff08:no_tasks");
    expect(f[0].ref.goalId).toBe("ffffffff-ffff-ffff-ffff-ffffffffff08");
    expect(f[0].severity).toBe("warn");
    expect(f[0].detail.reason).toBe("no_tasks");
  });

  it("flags an active goal with completed evidence but no next action", async () => {
    await insertGoal("ffffffff-ffff-ffff-ffff-ffffffffff09", {
      updatedHoursAgo: 2,
      createdHoursAgo: 4,
    });
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, goal_id,
                         completed_at, created_at, updated_at, result_summary)
      VALUES (${HIVE_ID}, 'dev-agent', 'goal-supervisor', 'completed', 'finished slice', 'b',
              'ffffffff-ffff-ffff-ffff-ffffffffff09',
              NOW() - interval '45 minutes',
              NOW() - interval '3 hours',
              NOW() - interval '45 minutes',
              ${"x".repeat(250)})
    `;

    const { findings } = await scanHive(sql, HIVE_ID);
    const f = findings.filter((x) => x.kind === "goal_lifecycle_gap");

    expect(f).toHaveLength(1);
    expect(f[0].id).toBe("goal_lifecycle_gap:ffffffff-ffff-ffff-ffff-ffffffffff09:completed_no_closure");
    expect(f[0].detail.reason).toBe("completed_no_closure");
  });

  it("does NOT flag a goal with runnable work", async () => {
    await insertGoal("ffffffff-ffff-ffff-ffff-ffffffffff0a", {
      updatedHoursAgo: 2,
      createdHoursAgo: 2,
    });
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, goal_id, updated_at)
      VALUES (${HIVE_ID}, 'dev-agent', 'goal-supervisor', 'pending', 'next task', 'b',
              'ffffffff-ffff-ffff-ffff-ffffffffff0a', NOW() - interval '2 hours')
    `;

    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((x) => x.kind === "goal_lifecycle_gap")).toHaveLength(0);
  });

  it("does NOT flag a goal with a recent supervisor/comment activity", async () => {
    await insertGoal("ffffffff-ffff-ffff-ffff-ffffffffff0b", {
      updatedHoursAgo: 2,
      createdHoursAgo: 2,
    });
    await sql`
      INSERT INTO goal_comments (goal_id, body, created_by, created_at)
      VALUES ('ffffffff-ffff-ffff-ffff-ffffffffff0b', 'checking this', 'goal-supervisor', NOW() - interval '10 minutes')
    `;

    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((x) => x.kind === "goal_lifecycle_gap")).toHaveLength(0);
  });
});

describe.sequential("scanHive - orphan_output detector", () => {
  async function insertOwnerDirectCompleted(
    id: string,
    opts: {
      assignedTo?: string;
      title?: string;
      hoursAgo?: number;
      parentId?: string | null;
      goalId?: string | null;
    } = {},
  ) {
    const assignedTo = opts.assignedTo ?? "dev-agent";
    const title = opts.title ?? "owner task";
    const hours = opts.hoursAgo ?? 1;
    const parent = opts.parentId ?? null;
    const goal = opts.goalId ?? null;
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief,
                         parent_task_id, goal_id, completed_at, created_at, updated_at)
      VALUES (${id}, ${HIVE_ID}, ${assignedTo}, 'owner', 'completed', ${title}, 'b',
              ${parent}, ${goal},
              NOW() - (${hours}::float || ' hours')::interval,
              NOW() - (${hours}::float || ' hours')::interval,
              NOW() - (${hours}::float || ' hours')::interval)
    `;
  }

  async function insertWorkProduct(taskId: string, role = "dev-agent") {
    await sql`
      INSERT INTO work_products (task_id, hive_id, role_slug, content)
      VALUES (${taskId}, ${HIVE_ID}, ${role}, 'deliverable body')
    `;
  }

  it("flags a completed owner-direct task with a work_product, no follow-up", async () => {
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-000000000001");
    await insertWorkProduct("10101010-0000-0000-0000-000000000001");
    const { findings } = await scanHive(sql, HIVE_ID);
    const f = findings.filter((x) => x.kind === "orphan_output");
    expect(f).toHaveLength(1);
    expect(f[0].ref.taskId).toBe("10101010-0000-0000-0000-000000000001");
    expect(f[0].id).toBe("orphan_output:10101010-0000-0000-0000-000000000001");
    // orphan_output is advisory-looking by nature; severity must stay 'info'
    // so the LLM (not the deterministic scanner) decides escalation.
    expect(f[0].severity).toBe("info");
    expect(f[0].detail.workProductCount).toBe(1);
  });

  it("does NOT flag a completed task with no work_product (no output to orphan)", async () => {
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-000000000002");
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((x) => x.kind === "orphan_output")).toHaveLength(0);
  });

  it("does NOT flag a completion newer than 30 minutes", async () => {
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-000000000003", {
      hoursAgo: 0.3,
    });
    await insertWorkProduct("10101010-0000-0000-0000-000000000003");
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((x) => x.kind === "orphan_output")).toHaveLength(0);
  });

  it("does NOT flag QA/doctor/goal-supervisor roles even when they emit work_products", async () => {
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-000000000004", {
      assignedTo: "qa",
    });
    await insertWorkProduct("10101010-0000-0000-0000-000000000004", "qa");
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-000000000005", {
      assignedTo: "doctor",
    });
    await insertWorkProduct("10101010-0000-0000-0000-000000000005", "doctor");
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((x) => x.kind === "orphan_output")).toHaveLength(0);
  });

  it("does NOT flag '[QA] Review:' or 'Fix environment for:' titled tasks", async () => {
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-000000000006", {
      title: "[QA] Review: something",
    });
    await insertWorkProduct("10101010-0000-0000-0000-000000000006");
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-000000000007", {
      title: "Fix environment for: a thing",
    });
    await insertWorkProduct("10101010-0000-0000-0000-000000000007");
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((x) => x.kind === "orphan_output")).toHaveLength(0);
  });

  it("does NOT flag descendant (parent_task_id IS NOT NULL) tasks", async () => {
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-000000000008");
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-000000000009", {
      parentId: "10101010-0000-0000-0000-000000000008",
    });
    await insertWorkProduct("10101010-0000-0000-0000-000000000009");
    const { findings } = await scanHive(sql, HIVE_ID);
    const f = findings.filter(
      (x) =>
        x.kind === "orphan_output" &&
        x.ref.taskId === "10101010-0000-0000-0000-000000000009",
    );
    expect(f).toHaveLength(0);
  });

  it("does NOT flag a task that already spawned a child task or linked decision", async () => {
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-00000000000a");
    await insertWorkProduct("10101010-0000-0000-0000-00000000000a");
    await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, status, title, brief, parent_task_id)
      VALUES (${HIVE_ID}, 'dev-agent', 'system', 'pending', 'child', 'b',
              '10101010-0000-0000-0000-00000000000a')
    `;
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-00000000000b");
    await insertWorkProduct("10101010-0000-0000-0000-00000000000b");
    await sql`
      INSERT INTO decisions (hive_id, title, context, status, task_id)
      VALUES (${HIVE_ID}, 'followup', 'c', 'pending', '10101010-0000-0000-0000-00000000000b')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((x) => x.kind === "orphan_output")).toHaveLength(0);
  });

  // Boundary: completed_at age threshold is `< NOW() - interval '30 minutes'`.
  // The existing 18m case exercises the "well inside" side of the boundary;
  // these two cases pin the behavior right on either edge, so a future tweak
  // of the threshold (e.g. 20m / 45m) cannot silently pass.
  it("boundary: flags a completion exactly 31 minutes old (just past 30m threshold)", async () => {
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-00000000000c", {
      hoursAgo: 31 / 60,
    });
    await insertWorkProduct("10101010-0000-0000-0000-00000000000c");
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((x) => x.kind === "orphan_output")).toHaveLength(1);
  });

  it("boundary: does NOT flag a completion exactly 29 minutes old (just short of 30m threshold)", async () => {
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-00000000000d", {
      hoursAgo: 29 / 60,
    });
    await insertWorkProduct("10101010-0000-0000-0000-00000000000d");
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((x) => x.kind === "orphan_output")).toHaveLength(0);
  });

  // Terminal-role suppression (2026-04-22 false-positive loop fix).
  // Analysis-only roles emit work_products as the deliverable itself —
  // there is no follow-up child implied. Hive-supervisor self-scan is
  // explicitly excluded (hardcoded + terminal flag) so heartbeat audits
  // cannot flag each other's deliverables.
  it("does NOT flag hive-supervisor work_products (hardcoded self-scan exclusion)", async () => {
    // Flip terminal off to prove the hardcoded NOT IN still holds.
    await sql`UPDATE role_templates SET terminal = false WHERE slug = 'hive-supervisor'`;
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-00000000010a", {
      assignedTo: "hive-supervisor",
    });
    await insertWorkProduct("10101010-0000-0000-0000-00000000010a", "hive-supervisor");
    const { findings } = await scanHive(sql, HIVE_ID);
    expect(findings.filter((x) => x.kind === "orphan_output")).toHaveLength(0);
  });

  it("does NOT flag work_products from terminal roles (design-agent, research-analyst)", async () => {
    await sql`UPDATE role_templates SET terminal = true WHERE slug IN ('design-agent', 'research-analyst')`;
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-00000000010b", {
      assignedTo: "design-agent",
    });
    await insertWorkProduct("10101010-0000-0000-0000-00000000010b", "design-agent");
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-00000000010c", {
      assignedTo: "research-analyst",
    });
    await insertWorkProduct("10101010-0000-0000-0000-00000000010c", "research-analyst");
    // Control: non-terminal dev-agent with identical shape still fires.
    await insertOwnerDirectCompleted("10101010-0000-0000-0000-00000000010d", {
      assignedTo: "dev-agent",
    });
    await insertWorkProduct("10101010-0000-0000-0000-00000000010d", "dev-agent");
    const { findings } = await scanHive(sql, HIVE_ID);
    const f = findings.filter((x) => x.kind === "orphan_output");
    expect(f).toHaveLength(1);
    expect(f[0].ref.taskId).toBe("10101010-0000-0000-0000-00000000010d");
  });
});

/**
 * The supervisor's audit trail (supervisor_reports) and the applier's
 * dedupe-by-finding-id both assume that, given the same DB state, two
 * consecutive scans agree on the same set of findings in the same order
 * with the same ids and severities. If that invariant ever breaks, every
 * heartbeat would look like a fresh incident to the applier and the
 * audit log would stop being diffable. This test pins it down against a
 * multi-detector fixed state.
 */
describe.sequential("scanHive - deterministic HiveHealthReport", () => {
  it("produces identical finding ids + order + metrics across consecutive scans over a fixed DB state", async () => {
    // Stalled active task (warn) — stale heartbeat past 20m.
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief,
                         started_at, last_heartbeat, updated_at)
      VALUES ('20202020-0000-0000-0000-000000000001', ${HIVE_ID}, 'dev-agent', 'owner', 'active',
              'stalled', 'b',
              NOW() - interval '25 minutes', NOW() - interval '25 minutes',
              NOW() - interval '25 minutes')
    `;
    // Critical stalled via 3h+ runtime.
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief,
                         started_at, last_heartbeat, updated_at)
      VALUES ('20202020-0000-0000-0000-000000000002', ${HIVE_ID}, 'dev-agent', 'owner', 'active',
              'overrun', 'b',
              NOW() - interval '4 hours', NOW() - interval '30 seconds',
              NOW() - interval '30 seconds')
    `;
    // Aging urgent decision (>4h, no messages).
    await sql`
      INSERT INTO decisions (id, hive_id, title, context, status, priority, created_at)
      VALUES ('20202020-0000-0000-0000-000000000003', ${HIVE_ID}, 'urgent-aging', 'ctx',
              'pending', 'urgent', NOW() - interval '5 hours')
    `;
    // Unsatisfied completion (>30m, 250-char summary, no follow-up).
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief,
                         result_summary, completed_at, created_at, updated_at)
      VALUES ('20202020-0000-0000-0000-000000000004', ${HIVE_ID}, 'design-agent', 'owner', 'completed',
              'advisory', 'b', ${"x".repeat(250)},
              NOW() - interval '2 hours',
              NOW() - interval '2 hours',
              NOW() - interval '2 hours')
    `;
    // Dormant goal (no open tasks, no recent activity).
    await sql`
      INSERT INTO goals (id, hive_id, title, status, session_id, created_at, updated_at)
      VALUES ('20202020-0000-0000-0000-000000000005', ${HIVE_ID}, 'dormant', 'active',
              'sess-1', NOW() - interval '48 hours', NOW() - interval '48 hours')
    `;
    // Orphan output (owner-direct, work_product, no follow-up, >30m).
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief,
                         completed_at, created_at, updated_at)
      VALUES ('20202020-0000-0000-0000-000000000006', ${HIVE_ID}, 'dev-agent', 'owner', 'completed',
              'owner-direct deliverable', 'b',
              NOW() - interval '2 hours',
              NOW() - interval '2 hours',
              NOW() - interval '2 hours')
    `;
    await sql`
      INSERT INTO work_products (task_id, hive_id, role_slug, content)
      VALUES ('20202020-0000-0000-0000-000000000006', ${HIVE_ID}, 'dev-agent', 'deliverable body')
    `;
    // Recurring failure: 3 failed dev-agent tasks within 24h, clustering.
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief, failure_reason,
                         created_at, updated_at)
      VALUES
        ('20202020-0000-0000-0000-000000000007', ${HIVE_ID}, 'dev-agent', 'owner', 'failed', 't1', 'b',
         'Adapter timeout after 12000ms', NOW() - interval '1 hour', NOW() - interval '1 hour'),
        ('20202020-0000-0000-0000-000000000008', ${HIVE_ID}, 'dev-agent', 'owner', 'failed', 't2', 'b',
         'Adapter timeout after 13500ms', NOW() - interval '2 hours', NOW() - interval '2 hours'),
        ('20202020-0000-0000-0000-000000000009', ${HIVE_ID}, 'dev-agent', 'owner', 'failed', 't3', 'b',
         'Adapter timeout after 9800ms', NOW() - interval '3 hours', NOW() - interval '3 hours')
    `;

    const a = await scanHive(sql, HIVE_ID);
    const b = await scanHive(sql, HIVE_ID);

    // Audit-trail invariant: same ids, in the same order, same severities,
    // same kinds, same refs. `detail` fields carry NOW()-relative ages that
    // legitimately drift scan-to-scan, so we pin identity (not detail).
    const projection = (r: typeof a) =>
      r.findings.map((f) => ({
        id: f.id,
        kind: f.kind,
        severity: f.severity,
        ref: f.ref,
      }));
    expect(projection(a)).toEqual(projection(b));

    // Every detector should have produced at least one finding for this fixture.
    const kinds = new Set(a.findings.map((f) => f.kind));
    expect(kinds).toEqual(
      new Set([
        "stalled_task",
        "aging_decision",
        "recurring_failure",
        "unsatisfied_completion",
        "dormant_goal",
        "orphan_output",
      ]),
    );

    // Ordering invariant: critical precedes warn precedes info.
    const rank = { critical: 0, warn: 1, info: 2 } as const;
    for (let i = 1; i < a.findings.length; i++) {
      expect(rank[a.findings[i - 1].severity]).toBeLessThanOrEqual(
        rank[a.findings[i].severity],
      );
    }

    // Metrics are a structural count — byte-identical across scans.
    expect(a.metrics).toEqual(b.metrics);
    expect(a.hiveId).toBe(HIVE_ID);
    expect(a.hiveId).toBe(b.hiveId);
  });
});

/**
 * Scoping guard for the 2026-04-22 false-positive-loop fix.
 *
 * role_templates.terminal + the hardcoded NOT IN safety set are intended to
 * suppress exactly two detectors — unsatisfied_completion and orphan_output.
 * If a future refactor extended the suppression into stalled_task /
 * aging_decision / recurring_failure / dormant_goal, real watchdog outages
 * would go silent: a hive-supervisor heartbeat task whose adapter hung at
 * 3h+ runtime, or a recurring analyzer failure on research-analyst, would
 * both disappear from the scan.
 *
 * These tests pin the scope: terminal=true on a role is allowed to hide
 * self-referential findings only.
 */
describe.sequential("scanHive - terminal-flag suppression scoping", () => {
  it("still flags stalled active tasks owned by terminal roles (stalled_task is NOT scoped by terminal)", async () => {
    await sql`UPDATE role_templates SET terminal = true WHERE slug = 'research-analyst'`;
    // 25m-stale heartbeat on an analysis-only role — the analyzer hung.
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief,
                         started_at, last_heartbeat, updated_at)
      VALUES ('30303030-0000-0000-0000-000000000001', ${HIVE_ID}, 'research-analyst',
              'owner', 'active', 'hung analyzer', 'b',
              NOW() - interval '25 minutes', NOW() - interval '25 minutes',
              NOW() - interval '25 minutes')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    const stalled = findings.filter((f) => f.kind === "stalled_task");
    expect(stalled).toHaveLength(1);
    expect(stalled[0].ref.taskId).toBe(
      "30303030-0000-0000-0000-000000000001",
    );
    expect(stalled[0].ref.role).toBe("research-analyst");
  });

  it("still flags recurring_failure clusters on terminal roles (recurring_failure is NOT scoped by terminal)", async () => {
    await sql`UPDATE role_templates SET terminal = true WHERE slug = 'research-analyst'`;
    // Three failed analyzer runs in 24h with matching normalized signature.
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief,
                         failure_reason, created_at, updated_at)
      VALUES
        ('30303030-0000-0000-0000-000000000011', ${HIVE_ID}, 'research-analyst',
         'owner', 'failed', 't1', 'b',
         'Adapter timeout after 11000ms',
         NOW() - interval '1 hour', NOW() - interval '1 hour'),
        ('30303030-0000-0000-0000-000000000012', ${HIVE_ID}, 'research-analyst',
         'owner', 'failed', 't2', 'b',
         'Adapter timeout after 12500ms',
         NOW() - interval '2 hours', NOW() - interval '2 hours'),
        ('30303030-0000-0000-0000-000000000013', ${HIVE_ID}, 'research-analyst',
         'owner', 'failed', 't3', 'b',
         'Adapter timeout after 9300ms',
         NOW() - interval '3 hours', NOW() - interval '3 hours')
    `;
    const { findings } = await scanHive(sql, HIVE_ID);
    const recurring = findings.filter((f) => f.kind === "recurring_failure");
    expect(recurring).toHaveLength(1);
    expect(recurring[0].severity).toBe("critical");
    expect(recurring[0].ref.role).toBe("research-analyst");
    expect(recurring[0].detail.count).toBe(3);
  });
});

/**
 * End-to-end seam: role-library YAML → syncRoleLibrary → role_templates.terminal
 * → detector suppression. The individual halves are tested in tests/roles/sync
 * and the unsatisfied_completion / orphan_output describes above, but without
 * a coupling test a drifted column name or a changed ON CONFLICT clause could
 * pass both halves while silently changing which roles are exempt.
 *
 * This test drives the pipeline the way production does: it runs
 * syncRoleLibrary() against the real role-library/ directory (no manual
 * UPDATE), then asserts that the detectors suppress only the actual
 * terminal roles shipped in role.yaml while executor commentary roles still
 * surface follow-up work.
 */
describe.sequential("scanHive - role-library YAML → DB → detector terminal-flag integration", () => {
  const roleLibraryPath = path.resolve(__dirname, "../../role-library");

  beforeEach(async () => {
    // Outer beforeEach left terminal=false across all seeded slugs (so the
    // baseline unsatisfied_completion/orphan_output tests fire). Re-run sync
    // so role_templates.terminal reflects the real YAML values and the
    // detector sees production state, not the test-reset baseline.
    await syncRoleLibrary(roleLibraryPath, sql);
  });

  it("after a real role-library sync, suppresses only the terminal YAML roles while executor follow-up roles still fire", async () => {
    // Sanity: syncRoleLibrary must actually persist the current role-library
    // mix of terminal and non-terminal roles. Skipping this check would mask
    // a silent propagation regression.
    const flags = await sql<Array<{ slug: string; terminal: boolean }>>`
      SELECT slug, terminal FROM role_templates
      WHERE slug IN (
        'hive-supervisor', 'qa', 'doctor', 'goal-supervisor',
        'research-analyst', 'design-agent', 'dev-agent'
      )
      ORDER BY slug
    `;
    const byRole = Object.fromEntries(flags.map((r) => [r.slug, r.terminal]));
    expect(byRole).toEqual({
      "design-agent": false,
      "dev-agent": false,
      doctor: true,
      "goal-supervisor": true,
      "hive-supervisor": true,
      qa: true,
      "research-analyst": false,
    });

    // Only the actual terminal roles from role.yaml should be suppressed.
    const terminalTasks: Array<[string, string]> = [
      ["40404040-0000-0000-0000-000000000001", "hive-supervisor"],
      ["40404040-0000-0000-0000-000000000002", "doctor"],
      ["40404040-0000-0000-0000-000000000003", "qa"],
      ["40404040-0000-0000-0000-000000000004", "goal-supervisor"],
    ];
    for (const [taskId, role] of terminalTasks) {
      await sql`
        INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief,
                           result_summary, completed_at, created_at, updated_at)
        VALUES (${taskId}, ${HIVE_ID}, ${role}, 'owner', 'completed',
                ${"terminal deliverable"}, 'b', ${"x".repeat(250)},
                NOW() - interval '2 hours',
                NOW() - interval '2 hours',
                NOW() - interval '2 hours')
      `;
      await sql`
        INSERT INTO work_products (task_id, hive_id, role_slug, content)
        VALUES (${taskId}, ${HIVE_ID}, ${role}, 'deliverable body')
      `;
    }

    // Controls: non-terminal executor roles with the same shape must still fire.
    const devTaskId = "40404040-0000-0000-0000-0000000000ff";
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief,
                         result_summary, completed_at, created_at, updated_at)
      VALUES (${devTaskId}, ${HIVE_ID}, 'dev-agent', 'owner', 'completed',
              'owner-direct deliverable', 'b', ${"x".repeat(250)},
              NOW() - interval '2 hours',
              NOW() - interval '2 hours',
              NOW() - interval '2 hours')
    `;
    await sql`
      INSERT INTO work_products (task_id, hive_id, role_slug, content)
      VALUES (${devTaskId}, ${HIVE_ID}, 'dev-agent', 'deliverable body')
    `;
    const researchTaskId = "40404040-0000-0000-0000-0000000000fe";
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief,
                         result_summary, completed_at, created_at, updated_at)
      VALUES (${researchTaskId}, ${HIVE_ID}, 'research-analyst', 'owner', 'completed',
              'analysis deliverable', 'b', ${"x".repeat(250)},
              NOW() - interval '2 hours',
              NOW() - interval '2 hours',
              NOW() - interval '2 hours')
    `;
    await sql`
      INSERT INTO work_products (task_id, hive_id, role_slug, content)
      VALUES (${researchTaskId}, ${HIVE_ID}, 'research-analyst', 'deliverable body')
    `;
    const designTaskId = "40404040-0000-0000-0000-0000000000fd";
    await sql`
      INSERT INTO tasks (id, hive_id, assigned_to, created_by, status, title, brief,
                         result_summary, completed_at, created_at, updated_at)
      VALUES (${designTaskId}, ${HIVE_ID}, 'design-agent', 'owner', 'completed',
              'design deliverable', 'b', ${"x".repeat(250)},
              NOW() - interval '2 hours',
              NOW() - interval '2 hours',
              NOW() - interval '2 hours')
    `;
    await sql`
      INSERT INTO work_products (task_id, hive_id, role_slug, content)
      VALUES (${designTaskId}, ${HIVE_ID}, 'design-agent', 'deliverable body')
    `;

    const { findings } = await scanHive(sql, HIVE_ID);

    const suppressed = new Set(terminalTasks.map(([id]) => id));
    const unsatisfied = findings
      .filter((f) => f.kind === "unsatisfied_completion")
      .map((f) => f.ref.taskId);
    const orphans = findings
      .filter((f) => f.kind === "orphan_output")
      .map((f) => f.ref.taskId);

    for (const hidden of suppressed) {
      expect(unsatisfied).not.toContain(hidden);
      expect(orphans).not.toContain(hidden);
    }
    expect(unsatisfied.sort()).toEqual([designTaskId, devTaskId, researchTaskId].sort());
    expect(orphans.sort()).toEqual([designTaskId, devTaskId, researchTaskId].sort());
  });
});
