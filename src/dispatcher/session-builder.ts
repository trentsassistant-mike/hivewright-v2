import type { Sql } from "postgres";
import type { ClaimedTask } from "./types";
import type { ImageWorkProductContext, SessionContext, RoleContext } from "../adapters/types";
import { resolveModel } from "../adapters/provider-config";
import { loadModelRoutingView } from "../model-routing/registry";
import { resolveConfiguredModelRoute } from "../model-routing/selector";
import { queryRelevantMemory } from "../memory/injection";
import { checkPgvectorAvailable } from "../memory/embeddings";
import { loadSystemSkills, loadHiveSkills, resolveSkillsForTask } from "../skills/loader";
import { loadCredentials } from "../credentials/manager";
import {
  AGENT_AUDIT_EVENTS,
  recordAgentAuditEventBestEffort,
} from "../audit/agent-events";
import { loadStandingInstructions } from "../standing-instructions/manager";
import { buildHiveContextBlock } from "../hives/context";
import path from "path";

export async function buildSessionContext(
  sql: Sql,
  task: ClaimedTask,
): Promise<SessionContext> {
  // 1. Load role template
  const [role] = await sql`
    SELECT slug, name, department, type, role_md, soul_md, tools_md,
           recommended_model, fallback_model,
           adapter_type, fallback_adapter_type, tools_config
    FROM role_templates
    WHERE slug = ${task.assignedTo} AND active = true
  `;
  if (!role) throw new Error(`Role template not found: ${task.assignedTo}`);

  const roleTemplate: RoleContext = {
    slug: role.slug,
    department: role.department,
    roleMd: role.role_md,
    soulMd: role.soul_md,
    toolsMd: role.tools_md,
  };

  // 2. Query memory (semantic search + recency ranking)
  const pgvectorEnabled = await checkPgvectorAvailable(sql);
  const memoryContext = await queryRelevantMemory(sql, {
    roleSlug: task.assignedTo,
    hiveId: task.hiveId,
    department: role.department,
    taskBrief: task.brief,
    pgvectorEnabled,
  });

  // 4. Workspace path (moved up so biz is available for skills)
  const [biz] = await sql`
    SELECT slug, workspace_path FROM hives WHERE id = ${task.hiveId}
  `;

  // 4b. If task has a projectId, use project workspace instead
  let projectWorkspace: string | null = biz?.workspace_path ?? null;
  if (task.projectId) {
    const [proj] = await sql`
      SELECT workspace_path FROM projects WHERE id = ${task.projectId}
    `;
    if (proj?.workspace_path) {
      projectWorkspace = proj.workspace_path as string;
    }
  }

  // Build the shared Hive Context block for the executor spawn. Sits
  // between Identity and Task layers in the adapter's translate() output.
  const hiveContext = await buildHiveContextBlock(sql, task.hiveId, projectWorkspace);

  // 2b. Load skills
  const roleSkillSlugs = await sql`SELECT skills FROM role_templates WHERE slug = ${task.assignedTo}`;
  const skillSlugs = normalizeSkillSlugs(roleSkillSlugs[0]?.skills);
  const systemSkills = loadSystemSkills(path.resolve(process.cwd(), "skills-library"));
  const hiveSkillsPath = biz?.workspace_path
    ? path.join(path.dirname(biz.workspace_path as string), "skills")
    : null;
  const hiveSkills = hiveSkillsPath ? loadHiveSkills(hiveSkillsPath) : [];
  const allSkills = [...systemSkills, ...hiveSkills];
  const skills = resolveSkillsForTask(allSkills, skillSlugs);

  // 2c. Load credentials
  const requiredKeys = parseRequiredCredentials(role.tools_md as string | null);
  const encryptionKey = process.env.ENCRYPTION_KEY || "";
  const agentId = `task:${task.id}`;
  if (encryptionKey && requiredKeys.length > 0) {
    await recordAgentAuditEventBestEffort(sql, {
      actor: { type: "system", id: "dispatcher", label: "Dispatcher" },
      eventType: AGENT_AUDIT_EVENTS.encryptionKeyAccessed,
      hiveId: task.hiveId,
      goalId: task.goalId,
      taskId: task.id,
      agentId,
      targetType: "encryption_key",
      targetId: "ENCRYPTION_KEY",
      outcome: "success",
      metadata: {
        purpose: "agent_spawn_credential_decryption",
        requiredCredentialKeys: requiredKeys,
        roleSlug: task.assignedTo,
      },
    });
  }
  const credentialsList = encryptionKey && requiredKeys.length > 0
    ? await loadCredentials(sql, {
        hiveId: task.hiveId,
        roleSlug: task.assignedTo,
        keys: requiredKeys,
        encryptionKey,
        auditContext: {
          actor: { type: "agent", id: task.assignedTo },
          hiveId: task.hiveId,
          goalId: task.goalId,
          taskId: task.id,
          agentId,
        },
      })
    : [];
  const credentials: Record<string, string> = {};
  for (const cred of credentialsList) {
    credentials[cred.key] = cred.value;
  }
  credentials.HIVEWRIGHT_TASK_ID = task.id;
  credentials.HIVEWRIGHT_HIVE_ID = task.hiveId;

  // 2d. Load standing instructions
  const standingInstructionRows = await loadStandingInstructions(sql, task.hiveId, role.department as string | null);
  const standingInstructions = standingInstructionRows.map((si) => si.content);

  // 3. Goal context
  let goalContext: string | null = null;
  if (task.goalId) {
    const [goal] = await sql`
      SELECT title, description, status, budget_cents, spent_cents
      FROM goals WHERE id = ${task.goalId}
    `;
    if (goal) {
      goalContext = `Goal: ${goal.title}\n${goal.description || ""}\nStatus: ${goal.status}, Budget: ${goal.budget_cents ? `${goal.spent_cents}/${goal.budget_cents} cents` : "unlimited"}`;
    }
  }

  // 4c. Fetch attachments (own + inherited from parent goal) and append to brief
  // Coerce "" → null so postgres.js parameterizes as SQL NULL (the cast `''::uuid` would throw).
  const goalIdParam = task.goalId || null;
  const attachmentRows = await sql`
    SELECT filename, storage_path
    FROM task_attachments
    WHERE task_id = ${task.id}
       OR (${goalIdParam}::uuid IS NOT NULL AND goal_id = ${goalIdParam})
    ORDER BY uploaded_at ASC
  `;

  const taskWithAttachments: ClaimedTask =
    attachmentRows.length > 0
      ? {
          ...task,
          brief:
            task.brief +
            "\n\n## Attachments\n" +
            attachmentRows
              .map((a) => `- ${a.filename as string}: ${a.storage_path as string}`)
              .join("\n"),
        }
      : task;
  const routingBrief = [
    taskWithAttachments.brief,
    goalContext ? `## Goal Context\n${goalContext}` : null,
  ].filter(Boolean).join("\n\n");

  // 5. Resolve model + adapter fallback metadata. Manual task overrides win;
  // role-level "auto" is resolved from hive adapter_config before dispatch.
  const configuredModel = task.modelOverride
    ? resolveModel(task.modelOverride, null)
    : ((role.recommended_model as string | null) ?? null);
  const configuredAdapter = task.adapterOverride ?? (role.adapter_type as string | null) ?? null;
  const { policy } = await loadModelRoutingView(sql, task.hiveId);
  const route = resolveConfiguredModelRoute({
    roleSlug: task.assignedTo,
    roleType: (role.type as string | null) ?? null,
    manualAdapterType: configuredAdapter,
    manualModel: configuredModel,
    policy,
    taskContext: {
      taskTitle: task.title,
      taskBrief: routingBrief,
      acceptanceCriteria: task.acceptanceCriteria,
      retryCount: task.retryCount,
    },
  });

  if (!route.adapterType || !route.model) {
    throw new Error(`Auto model routing unavailable for role ${task.assignedTo}: ${route.reason}`);
  }

  const model = route.model;
  const primaryAdapterType = route.adapterType;
  const fallbackModel = route.source === "auto_policy"
    ? null
    : (role.fallback_model as string | null) ?? null;
  const fallbackAdapterType = route.source === "auto_policy"
    ? null
    : (role.fallback_adapter_type as string | null) ?? null;

  let toolsConfig = (role.tools_config as { mcps?: string[]; allowedTools?: string[] } | null) ?? null;

  // Auto-classify tools per task when the role doesn't have an explicit
  // toolsConfig set. The classifier reads the brief + role and grants the
  // minimum MCPs the task is likely to need. An explicit per-role override
  // (set via the dashboard) ALWAYS wins — auto only fills the gap.
  if (toolsConfig === null) {
    const { classifyTaskTools, TASK_CLASSIFIER_MODE_DEFAULT } = await import("../tools/task-classifier");
    const classified = classifyTaskTools(
      { taskBrief: task.brief, taskTitle: task.title, roleSlug: task.assignedTo },
      TASK_CLASSIFIER_MODE_DEFAULT,
    );
    if (classified.mcps.length > 0) {
      toolsConfig = { mcps: classified.mcps };
      // Surface the classifier's reasoning into the live task feed for
      // debuggability — callers will see why the agent has the tools it has.
      try {
        const { writeTaskLog } = await import("./task-log-writer");
        await writeTaskLog(sql, {
          taskId: task.id,
          goalId: task.goalId ?? undefined,
          chunk: `[auto-tools] Granted MCPs: ${classified.mcps.join(", ")}\n${classified.reasons.map((r) => "  - " + r).join("\n")}`,
          type: "status",
        });
      } catch { /* logging is best-effort */ }
    }
  }

  const isQaReviewTask = (role.slug === "qa" || task.title.startsWith("[QA]"));
  const isQaReplanTask = task.title.startsWith("[Replan] QA failed repeatedly");
  const contextPolicy = isQaReviewTask || isQaReplanTask
    ? { mode: "lean" as const, reason: "review_replan_cost_control" as const }
    : (role.type as string | null) === "executor"
      ? { mode: "lean" as const, reason: "executor_default" as const }
      : { mode: "full" as const, reason: "non_executor" as const };

  return {
    task: taskWithAttachments,
    roleTemplate,
    memoryContext,
    skills,
    standingInstructions,
    goalContext,
    projectWorkspace,
    baseProjectWorkspace: projectWorkspace,
    hiveWorkspacePath: (biz?.workspace_path as string | null) ?? null,
    imageWorkProducts: await buildImageWorkProductContext(sql, task),
    hiveSlug: (biz?.slug as string | null) ?? null,
    hiveContext,
    model,
    fallbackModel,
    primaryAdapterType,
    fallbackAdapterType,
    credentials,
    toolsConfig,
    contextPolicy,
  };
}

export async function buildImageWorkProductContext(
  sql: Sql,
  task: ClaimedTask,
): Promise<ImageWorkProductContext[]> {
  const referencedWorkProductIds = extractUuidReferences([
    task.title,
    task.brief,
    task.acceptanceCriteria,
  ]);

  const rows = await sql<Array<{
    id: string;
    task_id: string;
    role_slug: string;
    file_path: string | null;
    mime_type: string | null;
    width: number | null;
    height: number | null;
    model_name: string | null;
    model_snapshot: string | null;
    prompt_tokens: number | null;
    output_tokens: number | null;
    cost_cents: number | null;
    metadata: Record<string, unknown> | null;
    source_task_title: string;
    source_task_brief: string;
    hive_workspace_path: string | null;
  }>>`
    WITH RECURSIVE task_ancestors AS (
      SELECT parent.id, parent.parent_task_id
      FROM tasks child
      JOIN tasks parent ON parent.id = child.parent_task_id
      WHERE child.id = ${task.id}
        AND child.hive_id = ${task.hiveId}
        AND parent.hive_id = ${task.hiveId}

      UNION ALL

      SELECT parent.id, parent.parent_task_id
      FROM task_ancestors ancestor
      JOIN tasks parent ON parent.id = ancestor.parent_task_id
      WHERE parent.hive_id = ${task.hiveId}
    )
    SELECT
      wp.id,
      wp.task_id,
      wp.role_slug,
      wp.file_path,
      wp.mime_type,
      wp.width,
      wp.height,
      wp.model_name,
      wp.model_snapshot,
      wp.prompt_tokens,
      wp.output_tokens,
      wp.cost_cents,
      wp.metadata,
      source_task.title AS source_task_title,
      source_task.brief AS source_task_brief,
      hives.workspace_path AS hive_workspace_path
    FROM work_products wp
    JOIN tasks source_task ON source_task.id = wp.task_id
    JOIN hives ON hives.id = wp.hive_id
    WHERE wp.hive_id = ${task.hiveId}
      AND source_task.hive_id = ${task.hiveId}
      AND wp.artifact_kind = 'image'
      AND wp.file_path IS NOT NULL
      AND wp.mime_type IN ('image/png', 'image/jpeg')
      AND wp.width IS NOT NULL
      AND wp.height IS NOT NULL
      AND (
        wp.id = ANY(${referencedWorkProductIds}::uuid[])
        OR wp.task_id IN (SELECT id FROM task_ancestors)
      )
    ORDER BY wp.created_at ASC
  `;

  return rows.flatMap((row) => {
    const metadata = normalizeMetadata(row.metadata);
    const imagePath = normalizeAuthorizedImagePath(
      row.file_path!,
      row.hive_workspace_path,
      row.task_id,
    );
    if (!imagePath) return [];

    return [{
      workProductId: row.id,
      taskId: row.task_id,
      roleSlug: row.role_slug,
      path: imagePath,
      diskPath: imagePath,
      imageRead: {
        type: "local_image",
        path: imagePath,
        mimeType: row.mime_type as "image/png" | "image/jpeg",
      },
      mimeType: row.mime_type as "image/png" | "image/jpeg",
      dimensions: { width: row.width!, height: row.height! },
      model: {
        name: row.model_name,
        snapshot: row.model_snapshot,
      },
      usage: {
        promptTokens: row.prompt_tokens,
        outputTokens: row.output_tokens,
        costCents: row.cost_cents,
      },
      originalImageBrief: {
        taskTitle: row.source_task_title,
        taskBrief: row.source_task_brief,
        prompt: extractOriginalPrompt(metadata),
      },
      metadata,
    }];
  });
}

function normalizeAuthorizedImagePath(
  filePath: string,
  hiveWorkspacePath: string | null,
  sourceTaskId: string,
): string | null {
  if (!hiveWorkspacePath) return null;

  const workspace = path.resolve(hiveWorkspacePath);
  const taskImageDir = path.resolve(workspace, sourceTaskId, "images");
  const resolvedFilePath = path.resolve(filePath);

  if (
    resolvedFilePath !== taskImageDir &&
    resolvedFilePath.startsWith(taskImageDir + path.sep)
  ) {
    return resolvedFilePath;
  }

  return null;
}

function extractUuidReferences(parts: Array<string | null | undefined>): string[] {
  const ids = new Set<string>();
  const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
  for (const part of parts) {
    if (!part) continue;
    for (const match of part.matchAll(uuidPattern)) {
      ids.add(match[0]);
    }
  }
  return [...ids];
}

function normalizeMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function extractOriginalPrompt(metadata: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  for (const key of ["originalPrompt", "prompt", "imagePrompt", "brief", "originalBrief"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  const sourceBrief = metadata.sourceBrief;
  if (sourceBrief && typeof sourceBrief === "object" && !Array.isArray(sourceBrief)) {
    const prompt = (sourceBrief as Record<string, unknown>).prompt;
    if (typeof prompt === "string" && prompt.trim().length > 0) return prompt;
  }
  return null;
}

function parseRequiredCredentials(toolsMd: string | null): string[] {
  if (!toolsMd) return [];
  const match = toolsMd.match(/requires:\s*\[([^\]]+)\]/i);
  if (!match) return [];
  return match[1].split(",").map((s) => s.trim()).filter(Boolean);
}

function normalizeSkillSlugs(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((slug): slug is string => typeof slug === "string");
  if (typeof value !== "string") return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((slug): slug is string => typeof slug === "string");
    }
  } catch {
    // Fall through to support a legacy single-slug string.
  }

  return value.trim().length > 0 ? [value] : [];
}
