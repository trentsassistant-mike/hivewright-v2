import type { Sql } from "postgres";
import { sql as appSql } from "../_lib/db";
import { persistAttachmentsForParent } from "@/attachments/persist";
import { runClassifier } from "@/work-intake/runner";
import { persistClassification } from "@/work-intake/persist";
import { resolveDefaultProjectIdForHive } from "@/projects/default-project";
import { assertHiveCreationAllowed } from "@/operations/creation-pause";

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

export class WorkIntakeValidationError extends Error {
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
