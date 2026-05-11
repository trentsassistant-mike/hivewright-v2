import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import { buildSessionContext } from "@/dispatcher/session-builder";
import { storeCredential } from "@/credentials/manager";
import { createRuntimeCredentialFingerprint } from "@/model-health/probe-runner";
import { syncRoleLibrary } from "@/roles/sync";
import type { ClaimedTask } from "@/dispatcher/types";
import { testSql as sql, truncateAll } from "../_lib/test-db";

let bizId: string;
const TEST_ENCRYPTION_KEY = "session-builder-audit-test-key";

beforeEach(async () => {
  await truncateAll(sql);
  await syncRoleLibrary(path.resolve(__dirname, "../../role-library"), sql, {
    resetModelAndAdapter: true,
  });

  const [biz] = await sql`
    INSERT INTO hives (slug, name, type, workspace_path)
    VALUES ('session-test-biz', 'Session Test', 'digital', '/tmp')
    RETURNING *
  `;
  bizId = biz.id;
  const defaultFingerprint = createRuntimeCredentialFingerprint({
    provider: "openai",
    adapterType: "codex",
    baseUrl: null,
  });
  await sql`
    INSERT INTO hive_models (
      hive_id,
      provider,
      model_id,
      adapter_type,
      benchmark_quality_score,
      routing_cost_score,
      enabled
    )
    VALUES (${bizId}, 'openai', 'openai-codex/gpt-5.5', 'codex', 90, 20, true)
  `;
  await sql`
    INSERT INTO model_health (fingerprint, model_id, status)
    VALUES (${defaultFingerprint}, 'openai-codex/gpt-5.5', 'healthy')
    ON CONFLICT (fingerprint, model_id) DO UPDATE SET status = EXCLUDED.status
  `;
  await sql`
    INSERT INTO adapter_config (hive_id, adapter_type, config)
    VALUES (
      ${bizId},
      'model-routing',
      ${sql.json({
        routeOverrides: {
          "openai:codex:openai-codex/gpt-5.5": {
            roleSlugs: ["dev-agent", "frontend-designer"],
          },
        },
      })}
    )
  `;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
});

describe("buildSessionContext", () => {
  it("resolves image-designer through the same auto routing policy as other roles", async () => {
    await sql`
      UPDATE role_templates
      SET adapter_type = 'auto',
          recommended_model = 'auto',
          fallback_adapter_type = NULL,
          fallback_model = NULL
      WHERE slug = 'image-designer'
    `;
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        benchmark_quality_score,
        routing_cost_score,
        enabled
      )
      VALUES (${bizId}, 'openai', 'gpt-image-3', 'openai-image', 99, 10, true)
    `;
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status)
      VALUES (
        ${createRuntimeCredentialFingerprint({
          provider: "openai",
          adapterType: "openai-image",
          baseUrl: null,
        })},
        'gpt-image-3',
        'healthy'
      )
      ON CONFLICT (fingerprint, model_id) DO UPDATE SET status = EXCLUDED.status
    `;
    await sql`
      INSERT INTO adapter_config (hive_id, adapter_type, config)
      VALUES (${bizId}, 'model-routing', ${sql.json({
        routeOverrides: {
          "openai:openai-image:gpt-image-3": {
            roleSlugs: ["image-designer"],
          },
        },
      })})
    `;

    const task: ClaimedTask = {
      id: "00000000-0000-0000-0000-000000000099",
      hiveId: bizId,
      assignedTo: "image-designer",
      createdBy: "owner",
      status: "active",
      priority: 5,
      title: "Generate honeycomb hero",
      brief: "Generate a HiveWright honeycomb hero image",
      parentTaskId: null,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: null,
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    };

    const ctx = await buildSessionContext(sql, task);

    expect(ctx.primaryAdapterType).toBe("openai-image");
    expect(ctx.model).toBe("gpt-image-3");
    expect(ctx.fallbackAdapterType).toBeNull();
    expect(ctx.fallbackModel).toBeNull();
    expect(ctx.contextPolicy).toEqual({ mode: "lean", reason: "executor_default" });
  });

  it("builds context with role template data", async () => {
    const task: ClaimedTask = {
      id: "00000000-0000-0000-0000-000000000001",
      hiveId: bizId,
      assignedTo: "dev-agent",
      createdBy: "owner",
      status: "active",
      priority: 5,
      title: "Build login page",
      brief: "Create a login page with email/password",
      parentTaskId: null,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: "Login form renders and submits",
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    };

    await sql`
      UPDATE role_templates
      SET adapter_type = 'claude-code',
          recommended_model = 'anthropic/claude-sonnet-4-6'
      WHERE slug = 'dev-agent'
    `;

    const ctx = await buildSessionContext(sql, task);

    expect(ctx.task).toBe(task);
    expect(ctx.roleTemplate.slug).toBe("dev-agent");
    expect(ctx.roleTemplate.roleMd).toContain("Developer");
    expect(ctx.roleTemplate.department).toBe("engineering");
    expect(ctx.model).toContain("anthropic");
    expect(ctx.memoryContext).toBeDefined();
    expect(ctx.memoryContext.roleMemory).toEqual([]);
    expect(ctx.memoryContext.hiveMemory).toEqual([]);
    expect(ctx.memoryContext.insights).toEqual([]);
    expect(ctx.memoryContext.capacity).toBe("0/200");
    expect(ctx.credentials.HIVEWRIGHT_TASK_ID).toBe(task.id);
    expect(ctx.credentials.HIVEWRIGHT_HIVE_ID).toBe(bizId);
    expect(ctx.contextPolicy).toEqual({ mode: "lean", reason: "executor_default" });
  });

  it("uses lean context for QA/replan system review tasks to prevent transcript replay", async () => {
    await sql`
      INSERT INTO role_templates (slug, name, type, adapter_type, recommended_model)
      VALUES ('qa', 'QA Reviewer', 'qa', 'claude-code', 'anthropic/claude-sonnet-4-6')
      ON CONFLICT (slug) DO UPDATE SET type = 'qa', adapter_type = 'claude-code', recommended_model = 'anthropic/claude-sonnet-4-6'
    `;

    const task: ClaimedTask = {
      id: "00000000-0000-0000-0000-0000000000aa",
      hiveId: bizId,
      assignedTo: "qa",
      createdBy: "dispatcher",
      status: "active",
      priority: 5,
      title: "[QA] Review latest deliverable",
      brief: "Verify latest evidence only",
      parentTaskId: "00000000-0000-0000-0000-0000000000ab",
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: null,
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    };

    const ctx = await buildSessionContext(sql, task);

    expect(ctx.contextPolicy).toEqual({ mode: "lean", reason: "review_replan_cost_control" });
  });

  it("resolves auto role routing from configured hive models and health", async () => {
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "openai",
      adapterType: "codex",
      baseUrl: null,
    });

    await sql`
      UPDATE role_templates
      SET adapter_type = 'auto',
          recommended_model = 'auto'
      WHERE slug = 'dev-agent'
    `;
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        benchmark_quality_score,
        routing_cost_score,
        enabled
      )
      VALUES (${bizId}, 'openai', 'openai-codex/gpt-5.5', 'codex', 96, 25, true)
      ON CONFLICT (hive_id, provider, model_id) DO UPDATE
      SET adapter_type = EXCLUDED.adapter_type,
          benchmark_quality_score = EXCLUDED.benchmark_quality_score,
          routing_cost_score = EXCLUDED.routing_cost_score,
          enabled = EXCLUDED.enabled
    `;
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status)
      VALUES (${fingerprint}, 'openai-codex/gpt-5.5', 'healthy')
      ON CONFLICT (fingerprint, model_id) DO UPDATE SET status = EXCLUDED.status
    `;
    await sql`
      INSERT INTO adapter_config (hive_id, adapter_type, config)
      VALUES (
        ${bizId},
        'model-routing',
        ${sql.json({
          preferences: { costQualityBalance: 17 },
          candidates: [
            {
              adapterType: "ollama",
              model: "legacy-policy/qwen3:32b",
              qualityScore: 100,
              costScore: 0,
              local: true,
            },
          ],
        })}
      )
    `;

    const task: ClaimedTask = {
      id: "00000000-0000-0000-0000-000000000088",
      hiveId: bizId,
      assignedTo: "dev-agent",
      createdBy: "owner",
      status: "active",
      priority: 5,
      title: "Auto route implementation task",
      brief: "Use the configured automatic model route",
      parentTaskId: null,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: null,
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    };

    const ctx = await buildSessionContext(sql, task);

    expect(ctx.primaryAdapterType).toBe("codex");
    expect(ctx.model).toBe("openai-codex/gpt-5.5");
  });

  it("passes task content into auto routing so coding task signals override role defaults", async () => {
    await sql`
      UPDATE role_templates
      SET adapter_type = 'auto',
          recommended_model = 'auto',
          fallback_adapter_type = NULL,
          fallback_model = NULL
      WHERE slug = 'content-writer'
    `;
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        benchmark_quality_score,
        routing_cost_score,
        enabled
      )
      VALUES
        (${bizId}, 'openai', 'openai-codex/gpt-5.5', 'codex', 96, 80, true),
        (${bizId}, 'google', 'google/gemini-3.1-flash-lite-preview', 'gemini', 88, 0, true)
      ON CONFLICT (hive_id, provider, model_id) DO UPDATE
      SET adapter_type = EXCLUDED.adapter_type,
          benchmark_quality_score = EXCLUDED.benchmark_quality_score,
          routing_cost_score = EXCLUDED.routing_cost_score,
          enabled = EXCLUDED.enabled
    `;
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status)
      VALUES
        (
          ${createRuntimeCredentialFingerprint({
            provider: "openai",
            adapterType: "codex",
            baseUrl: null,
          })},
          'openai-codex/gpt-5.5',
          'healthy'
        ),
        (
          ${createRuntimeCredentialFingerprint({
            provider: "google",
            adapterType: "gemini",
            baseUrl: null,
          })},
          'google/gemini-3.1-flash-lite-preview',
          'healthy'
        )
      ON CONFLICT (fingerprint, model_id) DO UPDATE SET status = EXCLUDED.status
    `;
    await sql`
      INSERT INTO model_capability_scores (
        provider,
        adapter_type,
        model_id,
        canonical_model_id,
        axis,
        score,
        raw_score,
        source,
        source_url,
        benchmark_name,
        model_version_matched,
        confidence
      )
      VALUES
        ('openai', 'codex', 'openai-codex/gpt-5.5', 'openai-codex/gpt-5.5', 'overall_quality', 100, '100', 'test', 'https://example.test/openai', 'session-builder-context', 'exact', 'high'),
        ('openai', 'codex', 'openai-codex/gpt-5.5', 'openai-codex/gpt-5.5', 'reasoning', 100, '100', 'test', 'https://example.test/openai', 'session-builder-context', 'exact', 'high'),
        ('openai', 'codex', 'openai-codex/gpt-5.5', 'openai-codex/gpt-5.5', 'coding', 80, '80', 'test', 'https://example.test/openai', 'session-builder-context', 'exact', 'high'),
        ('openai', 'codex', 'openai-codex/gpt-5.5', 'openai-codex/gpt-5.5', 'writing', 45, '45', 'test', 'https://example.test/openai', 'session-builder-context', 'exact', 'high'),
        ('openai', 'codex', 'openai-codex/gpt-5.5', 'openai-codex/gpt-5.5', 'tool_use', 100, '100', 'test', 'https://example.test/openai', 'session-builder-context', 'exact', 'high'),
        ('google', 'gemini', 'google/gemini-3.1-flash-lite-preview', 'google/gemini-3.1-flash-lite-preview', 'overall_quality', 50, '50', 'test', 'https://example.test/google', 'session-builder-context', 'exact', 'high'),
        ('google', 'gemini', 'google/gemini-3.1-flash-lite-preview', 'google/gemini-3.1-flash-lite-preview', 'reasoning', 95, '95', 'test', 'https://example.test/google', 'session-builder-context', 'exact', 'high'),
        ('google', 'gemini', 'google/gemini-3.1-flash-lite-preview', 'google/gemini-3.1-flash-lite-preview', 'coding', 45, '45', 'test', 'https://example.test/google', 'session-builder-context', 'exact', 'high'),
        ('google', 'gemini', 'google/gemini-3.1-flash-lite-preview', 'google/gemini-3.1-flash-lite-preview', 'writing', 95, '95', 'test', 'https://example.test/google', 'session-builder-context', 'exact', 'high'),
        ('google', 'gemini', 'google/gemini-3.1-flash-lite-preview', 'google/gemini-3.1-flash-lite-preview', 'tool_use', 95, '95', 'test', 'https://example.test/google', 'session-builder-context', 'exact', 'high'),
        ('google', 'gemini', 'google/gemini-3.1-flash-lite-preview', 'google/gemini-3.1-flash-lite-preview', 'speed', 100, '100', 'test', 'https://example.test/google', 'session-builder-context', 'exact', 'high')
    `;
    await sql`
      UPDATE adapter_config
      SET config = ${sql.json({
          preferences: { costQualityBalance: 100 },
          routeOverrides: {
            "openai:codex:openai-codex/gpt-5.5": {
              roleSlugs: ["content-writer"],
            },
            "google:gemini:google/gemini-3.1-flash-lite-preview": {
              roleSlugs: ["content-writer"],
            },
          },
        })}
      WHERE hive_id = ${bizId}
        AND adapter_type = 'model-routing'
    `;

    const writingDefaultTask: ClaimedTask = {
      id: "00000000-0000-0000-0000-000000000084",
      hiveId: bizId,
      assignedTo: "content-writer",
      createdBy: "owner",
      status: "active",
      priority: 5,
      title: "Draft release announcement",
      brief: "Write concise launch copy for the owner.",
      parentTaskId: null,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: "Announcement copy is polished and ready to send.",
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    };

    const task: ClaimedTask = {
      id: "00000000-0000-0000-0000-000000000085",
      hiveId: bizId,
      assignedTo: "content-writer",
      createdBy: "owner",
      status: "active",
      priority: 5,
      title: "Implement TypeScript API tests",
      brief: "Fix the route handler bug by writing TypeScript code and Vitest coverage.",
      parentTaskId: null,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: "API tests pass and the TypeScript implementation handles the error path.",
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    };

    const writingCtx = await buildSessionContext(sql, writingDefaultTask);
    const ctx = await buildSessionContext(sql, task);

    const [codingGoal] = await sql<{ id: string }[]>`
      INSERT INTO goals (hive_id, title, description, status, session_id)
      VALUES (
        ${bizId},
        'Implement TypeScript routing API',
        'Fix the route handler and add Vitest coverage for the coding workflow.',
        'active',
        'session-builder-routing-context'
      )
      RETURNING id
    `;
    const goalContextTask: ClaimedTask = {
      id: "00000000-0000-0000-0000-000000000083",
      hiveId: bizId,
      assignedTo: "content-writer",
      createdBy: "owner",
      status: "active",
      priority: 5,
      title: "Do the next action",
      brief: "Handle the next owner request.",
      parentTaskId: null,
      goalId: codingGoal.id,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: "The requested work is complete.",
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    };
    const goalContextCtx = await buildSessionContext(sql, goalContextTask);

    expect(writingCtx.primaryAdapterType).toBe("gemini");
    expect(writingCtx.model).toBe("google/gemini-3.1-flash-lite-preview");
    expect(ctx.primaryAdapterType).toBe("codex");
    expect(ctx.model).toBe("openai-codex/gpt-5.5");
    expect(goalContextCtx.primaryAdapterType).toBe("codex");
    expect(goalContextCtx.model).toBe("openai-codex/gpt-5.5");
  });

  it("does not route disabled hive models even when route overrides enable them", async () => {
    const fingerprint = createRuntimeCredentialFingerprint({
      provider: "openai",
      adapterType: "codex",
      baseUrl: null,
    });

    await sql`
      UPDATE role_templates
      SET adapter_type = 'auto',
          recommended_model = 'auto'
      WHERE slug = 'dev-agent'
    `;
    await sql`
      INSERT INTO hive_models (
        hive_id,
        provider,
        model_id,
        adapter_type,
        benchmark_quality_score,
        routing_cost_score,
        enabled
      )
      VALUES (${bizId}, 'openai', 'openai-codex/gpt-5.5', 'codex', 96, 25, false)
      ON CONFLICT (hive_id, provider, model_id) DO UPDATE
      SET adapter_type = EXCLUDED.adapter_type,
          benchmark_quality_score = EXCLUDED.benchmark_quality_score,
          routing_cost_score = EXCLUDED.routing_cost_score,
          enabled = EXCLUDED.enabled
    `;
    await sql`
      INSERT INTO model_health (fingerprint, model_id, status)
      VALUES (${fingerprint}, 'openai-codex/gpt-5.5', 'healthy')
      ON CONFLICT (fingerprint, model_id) DO UPDATE SET status = EXCLUDED.status
    `;
    await sql`
      INSERT INTO adapter_config (hive_id, adapter_type, config)
      VALUES (
        ${bizId},
        'model-routing',
        ${sql.json({
          preferences: { costQualityBalance: 17 },
          routeOverrides: {
            "openai:codex:openai-codex/gpt-5.5": {
              enabled: true,
              roleSlugs: ["dev-agent"],
            },
          },
        })}
      )
    `;

    const task: ClaimedTask = {
      id: "00000000-0000-0000-0000-000000000086",
      hiveId: bizId,
      assignedTo: "dev-agent",
      createdBy: "owner",
      status: "active",
      priority: 5,
      title: "Disabled registry route",
      brief: "Do not route disabled configured hive models",
      parentTaskId: null,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: null,
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    };

    await expect(buildSessionContext(sql, task)).rejects.toThrow(
      /Auto model routing unavailable/,
    );
  });

  it("lets task model and adapter overrides beat role auto routing", async () => {
    await sql`
      UPDATE role_templates
      SET adapter_type = 'auto',
          recommended_model = 'auto'
      WHERE slug = 'dev-agent'
    `;
    await sql`
      INSERT INTO adapter_config (hive_id, adapter_type, config)
      VALUES (
        ${bizId},
        'model-routing',
        ${sql.json({
          candidates: [
            {
              adapterType: "ollama",
              model: "ollama/qwen3:32b",
              qualityScore: 80,
              costScore: 0,
            },
          ],
        })}
      )
    `;

    const task: ClaimedTask = {
      id: "00000000-0000-0000-0000-000000000087",
      hiveId: bizId,
      assignedTo: "dev-agent",
      createdBy: "owner",
      status: "active",
      priority: 5,
      title: "Manual override task",
      brief: "Use explicit task route",
      parentTaskId: null,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: null,
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      adapterOverride: "codex",
      modelOverride: "openai-codex/gpt-5.5",
      projectId: null,
    };

    const ctx = await buildSessionContext(sql, task);

    expect(ctx.primaryAdapterType).toBe("codex");
    expect(ctx.model).toBe("openai-codex/gpt-5.5");
  });

  it("audits agent-spawn credential decryption and encryption-key access without secret material", async () => {
    const credentialKey = "SESSION_BUILDER_AUDIT_TOKEN";
    const secretValue = "spawn-secret-value-never-log";
    await storeCredential(sql, {
      hiveId: bizId,
      name: "Session builder audit token",
      key: credentialKey,
      value: secretValue,
      rolesAllowed: ["dev-agent"],
      encryptionKey: TEST_ENCRYPTION_KEY,
    });
    await sql`
      UPDATE role_templates
      SET tools_md = ${`# Tools\nrequires: [${credentialKey}]`}
      WHERE slug = 'dev-agent'
    `;
    const [taskRow] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'dev-agent', 'owner', 'Spawn with credential', 'Use the credential.', 'active')
      RETURNING id
    `;

    const task: ClaimedTask = {
      id: taskRow.id,
      hiveId: bizId,
      assignedTo: "dev-agent",
      createdBy: "owner",
      status: "active",
      priority: 5,
      title: "Spawn with credential",
      brief: "Use the credential.",
      parentTaskId: null,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: null,
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    };

    const ctx = await buildSessionContext(sql, task);
    expect(ctx.credentials[credentialKey]).toBe(secretValue);

    const events = await sql<{ event_type: string; metadata_text: string }[]>`
      SELECT event_type, metadata::text AS metadata_text
      FROM agent_audit_events
      WHERE task_id = ${task.id}
      ORDER BY created_at ASC
    `;
    expect(events.map((event) => event.event_type)).toEqual([
      "credential.encryption_key_accessed",
      "credential.decrypted_for_agent_spawn",
    ]);
    const serialized = JSON.stringify(events);
    expect(serialized).toContain(credentialKey);
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain(TEST_ENCRYPTION_KEY);
  });

  it("includes goal context when task has a goal", async () => {
    const [goal] = await sql`
      INSERT INTO goals (hive_id, title, description, status, session_id)
      VALUES (${bizId}, 'session-test-goal', 'Build an amazing product', 'active', 'gs-session-test-fixture')
      RETURNING *
    `;

    const task: ClaimedTask = {
      id: "00000000-0000-0000-0000-000000000002",
      hiveId: bizId,
      assignedTo: "dev-agent",
      createdBy: "goal-supervisor",
      status: "active",
      priority: 5,
      title: "Build login page",
      brief: "Create a login page",
      parentTaskId: null,
      goalId: goal.id,
      sprintNumber: 1,
      qaRequired: true,
      acceptanceCriteria: null,
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    };

    const ctx = await buildSessionContext(sql, task);
    expect(ctx.goalContext).toContain("Build an amazing product");
  });

  it("includes same-hive parent image work_products in frontend-designer context", async () => {
    const [imageTask] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'image-designer', 'owner', 'Generate honeycomb hero', 'Prompt: vibrant hive hero image', 'completed')
      RETURNING *
    `;
    const [imageWp] = await sql`
      INSERT INTO work_products (
        task_id, hive_id, role_slug, content, summary, artifact_kind, file_path,
        mime_type, width, height, model_name, model_snapshot, prompt_tokens,
        output_tokens, cost_cents, metadata
      )
      VALUES (
        ${imageTask.id}, ${bizId}, 'image-designer', 'Generated image', 'Generated image',
        'image', ${`/tmp/${imageTask.id}/images/hero.png`},
        'image/png', 1536, 864, 'gpt-image-2', 'gpt-image-2-2026-04-21',
        2100, 900, 4, ${sql.json({ originalPrompt: "vibrant hive hero image" })}
      )
      RETURNING *
    `;
    const [designTask] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id)
      VALUES (${bizId}, 'frontend-designer', 'goal-supervisor', 'Turn hero into Tailwind component', 'Use the generated hero image.', 'active', ${imageTask.id})
      RETURNING *
    `;

    const ctx = await buildSessionContext(sql, {
      id: designTask.id,
      hiveId: bizId,
      assignedTo: "frontend-designer",
      createdBy: "goal-supervisor",
      status: "active",
      priority: 5,
      title: "Turn hero into Tailwind component",
      brief: "Use the generated hero image.",
      parentTaskId: imageTask.id,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: null,
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    });

    expect(ctx.imageWorkProducts).toHaveLength(1);
    expect(ctx.imageWorkProducts?.[0]).toMatchObject({
      workProductId: imageWp.id,
      taskId: imageTask.id,
      roleSlug: "image-designer",
      path: `/tmp/${imageTask.id}/images/hero.png`,
      diskPath: `/tmp/${imageTask.id}/images/hero.png`,
      imageRead: {
        type: "local_image",
        path: `/tmp/${imageTask.id}/images/hero.png`,
        mimeType: "image/png",
      },
      mimeType: "image/png",
      dimensions: { width: 1536, height: 864 },
      model: { name: "gpt-image-2", snapshot: "gpt-image-2-2026-04-21" },
      usage: { promptTokens: 2100, outputTokens: 900, costCents: 4 },
      originalImageBrief: {
        taskTitle: "Generate honeycomb hero",
        taskBrief: "Prompt: vibrant hive hero image",
        prompt: "vibrant hive hero image",
      },
    });
  });

  it("omits explicitly referenced cross-hive image work_products", async () => {
    const [otherHive] = await sql`
      INSERT INTO hives (slug, name, type, workspace_path)
      VALUES ('other-session-biz', 'Other Session', 'digital', '/tmp/other')
      RETURNING *
    `;
    const [otherTask] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${otherHive.id}, 'image-designer', 'owner', 'Other image', 'Do not leak', 'completed')
      RETURNING *
    `;
    const [otherWp] = await sql`
      INSERT INTO work_products (
        task_id, hive_id, role_slug, content, summary, artifact_kind, file_path,
        mime_type, width, height, model_name, model_snapshot
      )
      VALUES (
        ${otherTask.id}, ${otherHive.id}, 'image-designer', 'Other image', 'Other image',
        'image', ${`/tmp/other/${otherTask.id}/images/hero.png`},
        'image/png', 1024, 1024, 'gpt-image-2', 'gpt-image-2-2026-04-21'
      )
      RETURNING *
    `;

    const ctx = await buildSessionContext(sql, {
      id: "00000000-0000-0000-0000-000000000003",
      hiveId: bizId,
      assignedTo: "frontend-designer",
      createdBy: "owner",
      status: "active",
      priority: 5,
      title: "Use referenced work product",
      brief: `Try to use work_product ${otherWp.id}`,
      parentTaskId: null,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: null,
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    });

    expect(ctx.imageWorkProducts).toEqual([]);
  });

  it("omits same-hive image work_products whose path is outside the source task image directory", async () => {
    const [imageTask] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'image-designer', 'owner', 'Generate unsafe image', 'Prompt: unsafe path', 'completed')
      RETURNING *
    `;
    await sql`
      INSERT INTO work_products (
        task_id, hive_id, role_slug, content, summary, artifact_kind, file_path,
        mime_type, width, height, model_name, model_snapshot
      )
      VALUES (
        ${imageTask.id}, ${bizId}, 'image-designer', 'Generated image', 'Generated image',
        'image', '/etc/passwd',
        'image/png', 1024, 1024, 'gpt-image-2', 'gpt-image-2-2026-04-21'
      )
    `;
    const [designTask] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id)
      VALUES (${bizId}, 'frontend-designer', 'goal-supervisor', 'Use unsafe image', 'Use the parent image.', 'active', ${imageTask.id})
      RETURNING *
    `;

    const ctx = await buildSessionContext(sql, {
      id: designTask.id,
      hiveId: bizId,
      assignedTo: "frontend-designer",
      createdBy: "goal-supervisor",
      status: "active",
      priority: 5,
      title: "Use unsafe image",
      brief: "Use the parent image.",
      parentTaskId: imageTask.id,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: null,
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    });

    expect(ctx.imageWorkProducts).toEqual([]);
  });

  it("preserves existing non-image work_product behavior without adding image context", async () => {
    const [parentTask] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status)
      VALUES (${bizId}, 'dev-agent', 'owner', 'Write text handoff', 'Do text work', 'completed')
      RETURNING *
    `;
    await sql`
      INSERT INTO work_products (task_id, hive_id, role_slug, content, summary)
      VALUES (${parentTask.id}, ${bizId}, 'dev-agent', 'Plain text output', 'Plain text output')
    `;
    const [childTask] = await sql`
      INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, status, parent_task_id)
      VALUES (${bizId}, 'frontend-designer', 'owner', 'Design from text', 'Keep normal context intact.', 'active', ${parentTask.id})
      RETURNING *
    `;

    const ctx = await buildSessionContext(sql, {
      id: childTask.id,
      hiveId: bizId,
      assignedTo: "frontend-designer",
      createdBy: "owner",
      status: "active",
      priority: 5,
      title: "Design from text",
      brief: "Keep normal context intact.",
      parentTaskId: parentTask.id,
      goalId: null,
      sprintNumber: null,
      qaRequired: false,
      acceptanceCriteria: "Normal context still renders",
      retryCount: 0,
      doctorAttempts: 0,
      failureReason: null,
      projectId: null,
    });

    expect(ctx.imageWorkProducts).toEqual([]);
    expect(ctx.task.brief).toBe("Keep normal context intact.");
    expect(ctx.task.acceptanceCriteria).toBe("Normal context still renders");
  });
});
