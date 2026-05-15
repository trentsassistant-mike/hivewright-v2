import { describe, it, expect, beforeEach } from "vitest";
import { buildSessionContext } from "@/dispatcher/session-builder";
import { storeCredential } from "@/credentials/manager";
import { syncRoleLibrary } from "@/roles/sync";
import type { ClaimedTask } from "@/dispatcher/types";
import { seedTestModelRoutingForHive, testSql as sql, truncateAll } from "../_lib/test-db";
import path from "path";

const TEST_KEY = "test-placeholder-key-replace-32ch";
const TEST_PREFIX = "p6-sb-";

let bizId: string;
let roleSlug: string;

beforeEach(async () => {
  await truncateAll(sql);

  // Set ENCRYPTION_KEY so session-builder can decrypt credentials during tests
  process.env.ENCRYPTION_KEY = TEST_KEY;

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type, workspace_path)
    VALUES (${TEST_PREFIX + "biz"}, 'P6 Session Builder Test', 'digital', '/tmp')
    RETURNING id
  `;
  bizId = biz.id;
  await seedTestModelRoutingForHive(bizId, sql);

  // Create a test-specific role so syncRoleLibrary in parallel tests doesn't stomp our changes
  roleSlug = `${TEST_PREFIX}role`;
  await sql`
    INSERT INTO role_templates (slug, name, department, type, adapter_type, role_md, soul_md, tools_md, skills, active)
    VALUES (
      ${roleSlug}, 'P6 Test Role', 'engineering', 'executor', 'claude-code',
      '# P6 Test Developer', '# P6 Test Soul', '', ${sql.json([])}, true
    )
    ON CONFLICT (slug) DO UPDATE SET
      name = 'P6 Test Role', department = 'engineering', type = 'executor', adapter_type = 'claude-code',
      role_md = '# P6 Test Developer', soul_md = '# P6 Test Soul', tools_md = '', skills = ${sql.json([])}, active = true
  `;
});

function makeTask(overrides: Partial<ClaimedTask> = {}): ClaimedTask {
  return {
    id: "00000000-0000-0000-0000-000000000099",
    hiveId: bizId,
    assignedTo: roleSlug,
    createdBy: "owner",
    status: "active",
    priority: 5,
    title: "Test task",
    brief: "A test task brief",
    parentTaskId: null,
    goalId: null,
    sprintNumber: null,
    qaRequired: false,
    acceptanceCriteria: null,
    retryCount: 0,
    doctorAttempts: 0,
    failureReason: null,
    projectId: null,
    ...overrides,
  };
}

async function insertTask(overrides: Partial<ClaimedTask> = {}): Promise<ClaimedTask> {
  const task = makeTask(overrides);
  const [row] = await sql`
    INSERT INTO tasks (
      id, hive_id, assigned_to, created_by, title, brief, status, priority,
      goal_id, parent_task_id, sprint_number, qa_required, acceptance_criteria,
      retry_count, doctor_attempts, failure_reason, project_id
    )
    VALUES (
      ${task.id}, ${task.hiveId}, ${task.assignedTo}, ${task.createdBy},
      ${task.title}, ${task.brief}, ${task.status}, ${task.priority},
      ${task.goalId}, ${task.parentTaskId}, ${task.sprintNumber},
      ${task.qaRequired}, ${task.acceptanceCriteria}, ${task.retryCount},
      ${task.doctorAttempts}, ${task.failureReason}, ${task.projectId}
    )
    RETURNING id
  `;

  return { ...task, id: row.id };
}

describe("session-builder Phase 6 — skills, credentials, standing instructions", () => {
  it("skills load by slug from skills-library", async () => {
    // Update dev-agent to include a known skill slug
    await sql`
      UPDATE role_templates
      SET skills = ${sql.json(["blog-writing"])}
      WHERE slug = ${roleSlug}
    `;

    const ctx = await buildSessionContext(sql, makeTask());

    // blog-writing skill exists in skills-library/blog-writing/SKILL.md
    expect(ctx.skills.length).toBeGreaterThan(0);
    expect(ctx.skills[0]).toContain("blog-writing");

    // Reset skills back to empty
    await sql`UPDATE role_templates SET skills = ${sql.json([])} WHERE slug = ${roleSlug}`;
  });

  it("credentials load and decrypt for role", async () => {
    const credKey = `${TEST_PREFIX}github-token`;

    // Store a credential that matches role and hive
    await storeCredential(sql, {
      hiveId: bizId,
      name: "GitHub Token",
      key: credKey,
      value: "ghp_test_secret_token",
      rolesAllowed: [roleSlug],
      encryptionKey: TEST_KEY,
    });

    // Update role tools_md to declare this credential as required
    await sql`
      UPDATE role_templates
      SET tools_md = ${`requires: [${credKey}]\n\nSome other content.`}
      WHERE slug = ${roleSlug}
    `;

    const ctx = await buildSessionContext(sql, makeTask());

    // Credentials should be loaded — keyed by credential key
    expect(ctx.credentials[credKey]).toBe("ghp_test_secret_token");

    // Restore tools_md on our test role (role_templates is preserved
    // across truncateAll, so revert to the beforeEach seed state).
    await sql`UPDATE role_templates SET tools_md = '' WHERE slug = ${roleSlug}`;
  });

  it("standing instructions load by department", async () => {
    // Insert a standing instruction for the dev-agent's department (engineering)
    await sql`
      INSERT INTO standing_instructions (hive_id, content, affected_departments, confidence)
      VALUES (
        ${bizId},
        'Always write tests before implementation.',
        ${sql.json(["engineering"])},
        0.92
      )
    `;

    const ctx = await buildSessionContext(sql, makeTask());

    // Should include the standing instruction content
    expect(ctx.standingInstructions.length).toBeGreaterThan(0);
    expect(ctx.standingInstructions.some((si) => si.includes("Always write tests"))).toBe(true);
  });

  it("audits explicit tool-grant decisions with granted and omitted tools", async () => {
    await sql`
      UPDATE role_templates
      SET tools_config = ${sql.json({
        mcps: ["github", "missing-mcp"],
        allowedTools: ["Bash", "Read"],
      })}
      WHERE slug = ${roleSlug}
    `;
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, description, status, session_id)
      VALUES (${bizId}, 'Tool grant session goal', 'Exercise session identity audit', 'active', 'gs-tool-grant-session')
      RETURNING id
    `;
    const task = await insertTask({
      title: "Explicit tools",
      brief: "Use configured role tools.",
      goalId: goal.id,
    });

    const ctx = await buildSessionContext(sql, task);

    expect(ctx.toolsConfig).toEqual({
      mcps: ["github", "missing-mcp"],
      allowedTools: ["Bash", "Read"],
    });
    const events = await sql<Array<{
      event_type: string;
      actor_type: string;
      actor_id: string;
      hive_id: string;
      task_id: string;
      agent_id: string;
      target_type: string;
      target_id: string;
      outcome: string;
      metadata: Record<string, unknown>;
    }>>`
      SELECT event_type, actor_type, actor_id, hive_id, task_id, agent_id,
             target_type, target_id, outcome, metadata
      FROM agent_audit_events
      WHERE task_id = ${task.id}
        AND event_type = 'tool.grant_decision'
      ORDER BY created_at ASC
    `;

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "tool.grant_decision",
      actor_type: "system",
      actor_id: "dispatcher",
      hive_id: bizId,
      task_id: task.id,
      agent_id: `task:${task.id}`,
      target_type: "tool_grant",
      target_id: roleSlug,
      outcome: "success",
    });
    expect(events[0].metadata).toMatchObject({
      roleSlug,
      assignee: roleSlug,
      sessionId: "gs-tool-grant-session",
      decisionSource: "role_tools_config",
      requestedToolSet: {
        mcps: ["github", "missing-mcp"],
        allowedTools: ["Bash", "Read"],
      },
      grantedToolSet: {
        mcps: ["github"],
        allowedTools: ["Bash", "Read"],
      },
      deniedToolSet: {
        mcps: ["missing-mcp"],
        allowedTools: [],
      },
      decisionReasons: ["role has explicit tools_config"],
    });
    expect(JSON.stringify(events[0].metadata)).not.toContain(TEST_KEY);
  });

  it("audits auto-classified tool-grant decisions with granted and omitted MCPs", async () => {
    await sql`
      UPDATE role_templates
      SET tools_config = NULL
      WHERE slug = ${roleSlug}
    `;
    const task = await insertTask({
      id: "00000000-0000-0000-0000-000000000098",
      title: "Browser verification",
      brief: "Open the dashboard in a browser and take a screenshot.",
    });

    const ctx = await buildSessionContext(sql, task);

    expect(ctx.toolsConfig).toEqual({ mcps: ["playwright"] });
    const events = await sql<Array<{ metadata: Record<string, unknown> }>>`
      SELECT metadata
      FROM agent_audit_events
      WHERE task_id = ${task.id}
        AND event_type = 'tool.grant_decision'
      ORDER BY created_at ASC
    `;

    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      roleSlug,
      assignee: roleSlug,
      decisionSource: "task_classifier",
      requestedToolSet: {
        mcps: ["context7", "github", "playwright", "sequential-thinking"],
        allowedTools: [],
      },
      grantedToolSet: {
        mcps: ["playwright"],
        allowedTools: [],
      },
      deniedToolSet: {
        mcps: ["context7", "github", "sequential-thinking"],
        allowedTools: [],
      },
    });
    expect((events[0].metadata.decisionReasons as string[])[0]).toContain("browser/UI verification");
  });

  it("loads the hive-supervisor heartbeat skill into the Skills layer after role-library sync", async () => {
    const repoRoot = path.resolve(__dirname, "../..");
    await syncRoleLibrary(path.join(repoRoot, "role-library"), sql);

    const [role] = await sql<Array<{ skills: string[] }>>`
      SELECT skills FROM role_templates WHERE slug = 'hive-supervisor'
    `;
    expect(role.skills).toContain("hive-supervisor-heartbeat");

    // This test focuses on skill/standing-instruction assembly; keep model
    // routing explicit so auto-routing policy availability does not obscure
    // regressions in the Skills layer after role sync.
    await sql`
      UPDATE role_templates
      SET adapter_type = 'claude-code', recommended_model = 'anthropic/claude-sonnet-4-6'
      WHERE slug = 'hive-supervisor'
    `;

    const [hive] = await sql`
      INSERT INTO hives (slug, name, type, workspace_path)
      VALUES (${TEST_PREFIX + "supervisor-hive"}, 'P6 Supervisor Hive', 'digital', '/tmp')
      RETURNING id
    `;
    await seedTestModelRoutingForHive(hive.id, sql);

    await sql`
      INSERT INTO standing_instructions (hive_id, content, affected_departments, confidence)
      VALUES (
        ${hive.id},
        'Before decomposition, investigate named runtime blockers such as the /hi redirect.',
        ${sql.json(["internal-audit"])},
        0.95
      )
    `;

    const originalCwd = process.cwd();
    let ctx: Awaited<ReturnType<typeof buildSessionContext>>;
    try {
      process.chdir(repoRoot);
      ctx = await buildSessionContext(
        sql,
        makeTask({
          hiveId: hive.id,
          assignedTo: "hive-supervisor",
          title: "Hive Supervisor heartbeat",
          brief:
            "Session stderr: codex_core::session: failed to record rollout items: thread 019dd0b1 not found",
        }),
      );
    } finally {
      process.chdir(originalCwd);
    }

    expect(ctx.skills).toHaveLength(1);
    expect(ctx.skills[0]).toContain("## Skill: hive-supervisor-heartbeat");
    expect(ctx.skills[0]).toContain("### 1. Stderr Scan");
    expect(ctx.skills[0]).toContain("emit a `create_decision` action");
    expect(ctx.standingInstructions.some((si) => si.includes("/hi redirect"))).toBe(true);
  }, 15_000);
});
