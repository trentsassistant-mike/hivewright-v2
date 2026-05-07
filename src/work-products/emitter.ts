import type { Sql } from "postgres";
import { assertPathInTaskImageDirectory } from "./image-storage";
import { classifySensitivity } from "./sensitivity";

export interface WorkProductInput {
  taskId: string;
  hiveId: string;
  roleSlug: string;
  department: string | null;
  content: string;
  summary: string | null;
  artifactKind?: "design-spec" | "image" | "text" | null;
  mimeType?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface BinaryWorkProductInput extends WorkProductInput {
  artifactKind: "image";
  filePath: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  modelName: string;
  modelSnapshot: string;
  promptTokens?: number | null;
  outputTokens?: number | null;
  costCents?: number | null;
  metadata?: Record<string, unknown> | null;
}

export function shouldEmitWorkProduct(taskTitle: string): boolean {
  if (taskTitle.startsWith("Result:")) return false;
  if (taskTitle.startsWith("ESCALATION:")) return false;
  if (taskTitle.startsWith("[Doctor]")) return false;
  return true;
}

export async function emitWorkProduct(sql: Sql, input: WorkProductInput) {
  const sensitivity = classifySensitivity(input.content);
  const metadata = input.metadata ? sql.json(input.metadata as Parameters<typeof sql.json>[0]) : null;

  const [wp] = await sql`
    INSERT INTO work_products (
      task_id, hive_id, role_slug, department, content, summary,
      artifact_kind, mime_type, metadata, sensitivity
    )
    VALUES (
      ${input.taskId},
      ${input.hiveId},
      ${input.roleSlug},
      ${input.department},
      ${input.content},
      ${input.summary},
      ${input.artifactKind ?? null},
      ${input.mimeType ?? null},
      ${metadata},
      ${sensitivity}
    )
    RETURNING *
  `;

  return wp;
}

export async function emitBinaryWorkProduct(sql: Sql, input: BinaryWorkProductInput) {
  const sensitivity = classifySensitivity(input.content);
  const metadata = input.metadata ? sql.json(input.metadata as Parameters<typeof sql.json>[0]) : null;
  if (input.mimeType !== "image/png" && input.mimeType !== "image/jpeg") {
    throw new Error("Binary image work products must be PNG or JPEG artifacts");
  }

  const [scope] = await sql`
    SELECT h.workspace_path
    FROM tasks t
    JOIN hives h ON h.id = t.hive_id
    WHERE t.id = ${input.taskId}
      AND t.hive_id = ${input.hiveId}
    LIMIT 1
  `;
  const hiveWorkspacePath = scope?.workspace_path as string | null | undefined;
  if (!hiveWorkspacePath) {
    throw new Error("Cannot emit binary image work product without a hive workspace path");
  }
  const filePath = assertPathInTaskImageDirectory({
    filePath: input.filePath,
    hiveWorkspacePath,
    taskId: input.taskId,
  });

  const [wp] = await sql`
    INSERT INTO work_products (
      task_id, hive_id, role_slug, department, content, summary,
      artifact_kind, file_path, mime_type, width, height, model_name, model_snapshot,
      prompt_tokens, output_tokens, cost_cents, metadata, sensitivity
    )
    VALUES (
      ${input.taskId},
      ${input.hiveId},
      ${input.roleSlug},
      ${input.department},
      ${input.content},
      ${input.summary},
      ${input.artifactKind},
      ${filePath},
      ${input.mimeType},
      ${input.width},
      ${input.height},
      ${input.modelName},
      ${input.modelSnapshot},
      ${input.promptTokens ?? null},
      ${input.outputTokens ?? null},
      ${input.costCents ?? null},
      ${metadata},
      ${sensitivity}
    )
    RETURNING *
  `;

  return wp;
}
