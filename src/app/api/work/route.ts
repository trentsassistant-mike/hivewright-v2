import type { Sql } from "postgres";
import { sql as appSql } from "../_lib/db";
import { jsonOk, jsonError } from "../_lib/responses";
import { enforceInternalTaskHiveScope, isInternalServiceAccountUser, requireApiUser } from "../_lib/auth";
import { canAccessHive } from "@/auth/users";
import { validateAttachmentFiles } from "@/attachments/constants";
import { persistAttachmentsForParent } from "@/attachments/persist";
import { runClassifier } from "@/work-intake/runner";
import { persistClassification } from "@/work-intake/persist";
import { maybeRecordEaHiveSwitch } from "@/ea/native/hive-switch-audit";
import { DefaultProjectResolutionError, resolveDefaultProjectIdForHive } from "@/projects/default-project";
import {
  assertHiveCreationAllowed,
  creationPausedResponse,
  databaseCreationPaused,
  isCreationPauseDbError,
} from "@/operations/creation-pause";

export interface SubmitWorkIntakeInput {
  // Allow runtimes/tests that already own a SQL connection to keep all writes
  // inside the same DB/session instead of jumping to the app-global handle.
  db?: Sql;
  hiveId: string;
  input: string;
  assignedTo?: string;
  projectId?: string | null;
  goalId?: string | null;
  sprintNumber?: number | null;
  qaRequired?: boolean;
  priority?: number;
  acceptanceCriteria?: string | null;
  files?: File[];
  createdBy: string;
  forceType?: "goal";
}

export interface SubmitWorkIntakeResult {
  type: "task" | "goal";
  id: string;
  title: string;
  classification: ReturnType<typeof outcomeSummary>;
}

class WorkIntakeValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "WorkIntakeValidationError";
    this.status = status;
  }
}

function deriveTitle(input: string): string {
  const firstSentence = input.split(/[.!?]/)[0].trim();
  return firstSentence.length > 0 ? firstSentence.slice(0, 500) : input.slice(0, 500);
}

async function resolveProjectId(
  db: Sql,
  hiveId: string,
  explicitProjectId: string | null | undefined,
  goalId?: string | null,
): Promise<string | null> {
  const resolvedProjectId = await resolveDefaultProjectIdForHive(db, hiveId, explicitProjectId);
  if (resolvedProjectId || !goalId) return resolvedProjectId;

  const [goalProject] = await db<{ project_id: string | null }[]>`
    SELECT project_id FROM goals WHERE id = ${goalId} AND hive_id = ${hiveId} LIMIT 1
  `;
  return goalProject?.project_id ?? null;
}

// Per-handler authorization (audit 2026-04-22 task-area pass).
// Work intake can insert into `tasks` and set `created_by` on the resulting
// row. Previously any authenticated session could target any hive and the
// task path hardcoded `created_by='owner'`, which let a non-owner caller
// launder work into another hive and forge owner-level attribution.
// Minimum hardening applied here:
//   1. Resolve the caller via `requireApiUser()` (not just session presence).
//   2. Enforce `canAccessHive()` on the supplied hiveId before any classifier
//      run or insert. System owners bypass membership via the helper itself.
//   3. Derive `created_by` from the session instead of hardcoding 'owner'.
// Role-slug attribution for non-owner supervisors remains blocked until role
// propagation lands in the JWT — see residual-risk note in the audit doc at
// `docs/security/2026-04-22-goal-task-mutation-auth-seams.md`.
export async function POST(request: Request) {
  const authz = await requireApiUser();
  if ("response" in authz) return authz.response;
  const { user } = authz;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    const isMultipart = contentType.includes("multipart/form-data");

    let hiveId: string;
    let input: string;
    let assignedTo: string | undefined;
    let projectId: string | undefined;
    let goalId: string | undefined;
    let sprintNumber: number | undefined;
    let qaRequired: boolean | undefined;
    let priority: number | undefined;
    let acceptanceCriteria: string | undefined;
    let forceType: "goal" | undefined;
    let requestedCreatedBy: string | undefined;
    let files: File[] = [];

    if (isMultipart) {
      const formData = await request.formData();
      hiveId = (formData.get("hiveId") as string) ?? "";
      input = (formData.get("input") as string) ?? "";
      assignedTo = (formData.get("assignedTo") as string) || undefined;
      projectId = ((formData.get("projectId") as string) || (formData.get("project_id") as string)) || undefined;
      goalId = (formData.get("goalId") as string) || undefined;
      const sprintNumberRaw = formData.get("sprintNumber");
      sprintNumber = typeof sprintNumberRaw === "string" && sprintNumberRaw.trim() !== ""
        ? Number(sprintNumberRaw)
        : undefined;
      qaRequired = formData.get("qaRequired") === "true";
      const priorityRaw = formData.get("priority");
      priority = typeof priorityRaw === "string" && priorityRaw.trim() !== ""
        ? Number(priorityRaw)
        : undefined;
      acceptanceCriteria = (formData.get("acceptanceCriteria") as string) || undefined;
      forceType = formData.get("forceType") === "goal" ? "goal" : undefined;
      requestedCreatedBy = (formData.get("createdBy") as string) || undefined;
      files = formData.getAll("files") as File[];
      const validationError = validateAttachmentFiles(files);
      if (validationError) return jsonError(validationError, 400);
    } else {
      const body = await request.json();
      ({ hiveId, input, assignedTo, projectId, goalId, sprintNumber, qaRequired, priority, acceptanceCriteria } = body);
      projectId = projectId ?? body.project_id;
      forceType = body.forceType === "goal" ? "goal" : undefined;
      requestedCreatedBy = typeof body.createdBy === "string" ? body.createdBy : undefined;
    }

    if (!hiveId || !input) return jsonError("Missing required fields: hiveId, input", 400);

    const taskScope = await enforceInternalTaskHiveScope(hiveId);
    if (!taskScope.ok) return taskScope.response;

    const creationPause = await assertHiveCreationAllowed(appSql, hiveId);
    if (creationPause) return creationPausedResponse(creationPause);

    if (!user.isSystemOwner) {
      const hasAccess = await canAccessHive(appSql, user.id, hiveId);
      if (!hasAccess) return jsonError("Forbidden: caller cannot access this hive", 403);
    }

    // tasks.created_by stores role slugs ("owner", "ea", "system", role
    // templates), not user ids — see the note in
    // src/app/api/attachments/[id]/download/route.ts. Until role propagation
    // lands, the only honest session-derived slug is "owner" for system
    // owners and "system" for any other in-scope caller.
    const createdBy = isInternalServiceAccountUser(user) && requestedCreatedBy === "initiative-engine"
      ? "initiative-engine"
      : user.isSystemOwner
        ? "owner"
        : "system";

    const data = await submitWorkIntake({
      hiveId,
      input,
      assignedTo,
      projectId,
      goalId,
      sprintNumber,
      qaRequired,
      priority,
      acceptanceCriteria,
      files,
      createdBy,
      forceType,
    });
    await maybeRecordEaHiveSwitch(appSql, request, hiveId, {
      type: data.type,
      id: data.id,
    });
    return jsonOk(data, 201);
  } catch (error) {
    if (isCreationPauseDbError(error)) {
      return creationPausedResponse(databaseCreationPaused());
    }
    if (error instanceof WorkIntakeValidationError || error instanceof DefaultProjectResolutionError) {
      return jsonError(error.message, error.status);
    }
    return jsonError("Failed to process work intake", 500);
  }
}

export async function submitWorkIntake(
  input: SubmitWorkIntakeInput,
): Promise<SubmitWorkIntakeResult> {
  const db = input.db ?? appSql;
  const creationPause = await assertHiveCreationAllowed(db, input.hiveId);
  if (creationPause) {
    throw new WorkIntakeValidationError(
      creationPause.reason
        ? `Hive creation is paused: ${creationPause.reason}`
        : "Hive creation is paused",
      423,
    );
  }
  const files = input.files ?? [];
  const title = deriveTitle(input.input);
  const resolvedProjectId = await resolveProjectId(
    db,
    input.hiveId,
    input.projectId,
    input.goalId ?? null,
  );
  await assertScopedReferences(db, input.hiveId, {
    goalId: input.goalId ?? null,
    projectId: resolvedProjectId,
  });

  // Explicit task override — no classifier run, no classifications row.
  if (input.assignedTo) {
    return await insertTask(
      db,
      input.hiveId,
      input.assignedTo,
      title,
      input.input,
      resolvedProjectId,
      input.goalId ?? null,
      input.sprintNumber ?? null,
      input.qaRequired ?? false,
      input.priority ?? 5,
      input.acceptanceCriteria ?? null,
      files,
      null,
      input.createdBy,
    );
  }

  if (input.forceType === "goal") {
    return await insertGoal(
      db,
      input.hiveId,
      title,
      input.input,
      resolvedProjectId,
      files,
      null,
    );
  }

  const outcome = await runClassifier(db, input.input);

  if (outcome.result?.type === "task") {
    return await insertTask(
      db,
      input.hiveId,
      outcome.result.role,
      title,
      input.input,
      resolvedProjectId,
      input.goalId ?? null,
      input.sprintNumber ?? null,
      input.qaRequired ?? false,
      input.priority ?? 5,
      input.acceptanceCriteria ?? null,
      files,
      outcome,
      input.createdBy,
    );
  }

  // Goal path: either classifier said goal, or classifier returned null and we're defaulting.
  const isDefault = outcome.result === null;
  const description = isDefault
    ? `${input.input}\n\n---\n*Automatically classified as a goal because work-intake could not produce a confident classification. Goal supervisor to decompose.*`
    : input.input;

  return await insertGoal(
    db,
    input.hiveId,
    title,
    description,
    resolvedProjectId,
    files,
    outcome,
  );
}

async function insertTask(
  db: Sql,
  hiveId: string,
  role: string,
  title: string,
  brief: string,
  resolvedProjectId: string | null,
  goalId: string | null,
  sprintNumber: number | null,
  qaRequired: boolean,
  priority: number,
  acceptanceCriteria: string | null,
  files: File[],
  outcome: Awaited<ReturnType<typeof runClassifier>> | null,
  createdBy: string,
): Promise<SubmitWorkIntakeResult> {
  const rows = await db`
    INSERT INTO tasks (
      hive_id, assigned_to, created_by, title, brief, qa_required, project_id, goal_id, sprint_number, priority, acceptance_criteria
    )
    VALUES (
      ${hiveId}, ${role}, ${createdBy}, ${title}, ${brief}, ${qaRequired}, ${resolvedProjectId}, ${goalId}, ${sprintNumber}, ${priority}, ${acceptanceCriteria}
    )
    RETURNING id, title
  `;
  const taskId = rows[0].id as string;
  const taskTitle = rows[0].title as string;

  await writeFiles(db, hiveId, files, taskId, null);

  if (outcome) await persistClassification(db, { target: "task", targetId: taskId, outcome });

  return {
    type: "task",
    id: taskId,
    title: taskTitle,
    classification: outcomeSummary(outcome),
  };
}

async function insertGoal(
  db: Sql,
  hiveId: string,
  title: string,
  description: string,
  resolvedProjectId: string | null,
  files: File[],
  outcome: Awaited<ReturnType<typeof runClassifier>> | null,
): Promise<SubmitWorkIntakeResult> {
  const rows = await db`
    INSERT INTO goals (hive_id, title, description, project_id)
    VALUES (${hiveId}, ${title}, ${description}, ${resolvedProjectId})
    RETURNING id, title
  `;
  const goalId = rows[0].id as string;
  const goalTitle = rows[0].title as string;

  await writeFiles(db, hiveId, files, null, goalId);
  if (outcome) {
    await persistClassification(db, { target: "goal", targetId: goalId, outcome });
  }

  return {
    type: "goal",
    id: goalId,
    title: goalTitle,
    classification: outcomeSummary(outcome),
  };
}

async function writeFiles(
  db: Sql,
  hiveId: string,
  files: File[],
  taskId: string | null,
  goalId: string | null,
) {
  if (files.length === 0) return;
  const ownerId = (taskId ?? goalId)!;
  await persistAttachmentsForParent(db, hiveId, ownerId, files, { taskId, goalId });
}

function outcomeSummary(outcome: Awaited<ReturnType<typeof runClassifier>> | null) {
  if (!outcome) return null;
  return {
    provider: outcome.providerUsed,
    model: outcome.modelUsed,
    confidence: outcome.result?.confidence ?? 0,
    reasoning: outcome.result?.reasoning ?? "default-to-goal: no confident classification",
    usedFallback: outcome.usedFallback,
  };
}

async function assertScopedReferences(
  db: Sql,
  hiveId: string,
  refs: { goalId?: string | null; projectId?: string | null },
): Promise<void> {
  if (refs.goalId) {
    const [goal] = await db`
      SELECT 1
      FROM goals
      WHERE id = ${refs.goalId}
        AND hive_id = ${hiveId}
      LIMIT 1
    `;
    if (!goal) {
      throw new WorkIntakeValidationError("Forbidden: goal does not belong to hive", 403);
    }
  }

  if (refs.projectId) {
    const [project] = await db`
      SELECT 1
      FROM projects
      WHERE id = ${refs.projectId}
        AND hive_id = ${hiveId}
      LIMIT 1
    `;
    if (!project) {
      throw new WorkIntakeValidationError("Forbidden: project does not belong to hive", 403);
    }
  }
}
