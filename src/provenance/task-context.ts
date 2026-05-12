import type { Sql } from "postgres";
import type { ContextProvenance, ContextProvenanceEntry, ContextSourceClass, SessionContext } from "@/adapters/types";
import { writeTaskLog } from "@/dispatcher/task-log-writer";

export const TASK_CONTEXT_PROVENANCE_KIND = "task_context_provenance";
export const TASK_CONTEXT_PROVENANCE_SCHEMA_VERSION = 1;
export const TASK_CONTEXT_PROVENANCE_DISCLAIMER =
  "Retrieved memory/context references only; not model-internal reasoning or confidence.";

const VALID_SOURCE_CLASSES = new Set<ContextSourceClass>([
  "role_memory",
  "hive_memory",
  "insight",
  "work_product",
  "task",
  "goal",
]);

export function emptyTaskContextProvenance(status: "none" | "unavailable"): ContextProvenance {
  return {
    status,
    entries: [],
    disclaimer: TASK_CONTEXT_PROVENANCE_DISCLAIMER,
  };
}

export function createTaskContextProvenance(entries: ContextProvenanceEntry[]): ContextProvenance {
  return {
    status: entries.length > 0 ? "available" : "none",
    entries,
    disclaimer: TASK_CONTEXT_PROVENANCE_DISCLAIMER,
  };
}

export function buildSessionContextProvenance(ctx: SessionContext): ContextProvenance {
  const entries: ContextProvenanceEntry[] = [
    ...(ctx.memoryContext.provenance?.entries ?? []),
  ];

  if (ctx.task.parentTaskId) {
    entries.push({
      sourceClass: "task",
      reference: `tasks:${ctx.task.parentTaskId}`,
      sourceId: ctx.task.parentTaskId,
      sourceTaskId: null,
      category: "parent_task",
    });
  }

  if (ctx.task.goalId) {
    entries.push({
      sourceClass: "goal",
      reference: `goals:${ctx.task.goalId}`,
      sourceId: ctx.task.goalId,
      sourceTaskId: null,
      category: "goal_context",
    });
  }

  for (const workProduct of ctx.imageWorkProducts ?? []) {
    entries.push({
      sourceClass: "work_product",
      reference: `work_products:${workProduct.workProductId}`,
      sourceId: workProduct.workProductId,
      sourceTaskId: workProduct.taskId,
      category: "image_context",
    });
  }

  return createTaskContextProvenance(dedupeEntries(entries));
}

export async function writeTaskContextProvenanceLog(
  sql: Sql,
  input: { taskId: string; goalId?: string; provenance: ContextProvenance },
): Promise<void> {
  await writeTaskLog(sql, {
    taskId: input.taskId,
    goalId: input.goalId,
    type: "diagnostic",
    chunk: JSON.stringify({
      kind: TASK_CONTEXT_PROVENANCE_KIND,
      schemaVersion: TASK_CONTEXT_PROVENANCE_SCHEMA_VERSION,
      status: input.provenance.status,
      entries: input.provenance.entries,
      disclaimer: TASK_CONTEXT_PROVENANCE_DISCLAIMER,
    }),
  });
}

export function normalizeTaskContextProvenance(value: unknown): ContextProvenance | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (source.kind !== TASK_CONTEXT_PROVENANCE_KIND) return null;

  const entries = Array.isArray(source.entries)
    ? source.entries.flatMap((entry) => {
        const normalized = normalizeEntry(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  const sourceStatus = source.status;
  if (sourceStatus === "none") return emptyTaskContextProvenance("none");
  if (sourceStatus === "available" || entries.length > 0) return createTaskContextProvenance(entries);
  return emptyTaskContextProvenance("unavailable");
}

export async function readLatestTaskContextProvenance(
  sql: Sql,
  taskId: string,
): Promise<ContextProvenance> {
  const marker = TASK_CONTEXT_PROVENANCE_KIND;
  const rows = await sql<{ chunk: unknown }[]>`
    SELECT chunk
    FROM task_logs
    WHERE task_id = ${taskId}
      AND type = 'diagnostic'
      AND chunk LIKE ${`%${marker}%`}
    ORDER BY id DESC
    LIMIT 10
  `;

  for (const row of rows) {
    const chunk = row.chunk;
    if (typeof chunk === "string") {
      try {
        const normalized = normalizeTaskContextProvenance(JSON.parse(chunk));
        if (normalized) return normalized;
      } catch {
        continue;
      }
    } else {
      const normalized = normalizeTaskContextProvenance(chunk);
      if (normalized) return normalized;
    }
  }

  return emptyTaskContextProvenance("unavailable");
}

function normalizeEntry(value: unknown): ContextProvenanceEntry | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const sourceClass = typeof source.sourceClass === "string" ? source.sourceClass : "";
  const reference = typeof source.reference === "string" ? source.reference : "";
  const sourceId = typeof source.sourceId === "string" ? source.sourceId : "";
  if (!VALID_SOURCE_CLASSES.has(sourceClass as ContextSourceClass) || !reference || !sourceId) {
    return null;
  }

  return {
    sourceClass: sourceClass as ContextSourceClass,
    reference,
    sourceId,
    sourceTaskId: typeof source.sourceTaskId === "string" ? source.sourceTaskId : null,
    category: typeof source.category === "string" ? source.category : null,
  };
}

function dedupeEntries(entries: ContextProvenanceEntry[]): ContextProvenanceEntry[] {
  const seen = new Set<string>();
  const deduped: ContextProvenanceEntry[] = [];
  for (const entry of entries) {
    const key = `${entry.sourceClass}:${entry.reference}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}
