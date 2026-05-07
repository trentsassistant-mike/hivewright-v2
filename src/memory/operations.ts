import type { Sql } from "postgres";
import type { MemoryOperation } from "./types";

export interface OperationContext {
  hiveId: string;
  roleSlug: string;
  sourceTaskId: string | null;
}

export interface OperationResult {
  operation: MemoryOperation;
  applied: boolean;
  resultId?: string;
  error?: string;
}

const DELETED_SENTINEL = "00000000-0000-0000-0000-000000000000";

export async function applyMemoryOperations(
  sql: Sql,
  operations: MemoryOperation[],
  ctx: OperationContext,
): Promise<OperationResult[]> {
  const results: OperationResult[] = [];
  for (const op of operations) {
    try {
      switch (op.operation) {
        case "ADD": {
          const resultId = await applyAdd(sql, op, ctx);
          results.push({ operation: op, applied: true, resultId });
          break;
        }
        case "UPDATE": {
          const resultId = await applyUpdate(sql, op);
          results.push({ operation: op, applied: true, resultId });
          break;
        }
        case "DELETE": {
          await applyDelete(sql, op);
          results.push({ operation: op, applied: true });
          break;
        }
        case "NOOP": {
          await applyNoop(sql, op);
          results.push({ operation: op, applied: true });
          break;
        }
      }
    } catch (err) {
      results.push({
        operation: op,
        applied: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

async function applyAdd(sql: Sql, op: MemoryOperation, ctx: OperationContext): Promise<string> {
  if (!op.content) throw new Error("ADD requires content");
  if (op.store === "role_memory") {
    const [row] = await sql`
      INSERT INTO role_memory (hive_id, role_slug, content, source_task_id, confidence)
      VALUES (${ctx.hiveId}, ${ctx.roleSlug}, ${op.content}, ${ctx.sourceTaskId}, ${op.confidence ?? 1.0})
      RETURNING id
    `;
    return row.id;
  } else {
    const [row] = await sql`
      INSERT INTO hive_memory (hive_id, category, content, source_task_id, confidence)
      VALUES (${ctx.hiveId}, ${op.category ?? "general"}, ${op.content}, ${ctx.sourceTaskId}, ${op.confidence ?? 1.0})
      RETURNING id
    `;
    return row.id;
  }
}

async function applyUpdate(sql: Sql, op: MemoryOperation): Promise<string> {
  if (!op.existingId) throw new Error("UPDATE requires existingId");
  if (!op.content) throw new Error("UPDATE requires content");
  if (op.store === "role_memory") {
    await sql`
      UPDATE role_memory SET content = ${op.content}, confidence = ${op.confidence ?? 1.0}, updated_at = NOW()
      WHERE id = ${op.existingId}
    `;
  } else {
    await sql`
      UPDATE hive_memory SET content = ${op.content}, confidence = ${op.confidence ?? 1.0}, updated_at = NOW()
      WHERE id = ${op.existingId}
    `;
  }
  return op.existingId;
}

async function applyDelete(sql: Sql, op: MemoryOperation): Promise<void> {
  if (!op.existingId) throw new Error("DELETE requires existingId");
  if (op.store === "role_memory") {
    await sql`UPDATE role_memory SET superseded_by = ${DELETED_SENTINEL}, updated_at = NOW() WHERE id = ${op.existingId}`;
  } else {
    await sql`UPDATE hive_memory SET superseded_by = ${DELETED_SENTINEL}, updated_at = NOW() WHERE id = ${op.existingId}`;
  }
}

async function applyNoop(sql: Sql, op: MemoryOperation): Promise<void> {
  if (!op.existingId) throw new Error("NOOP requires existingId");
  if (op.store === "role_memory") {
    await sql`UPDATE role_memory SET last_accessed = NOW(), access_count = access_count + 1 WHERE id = ${op.existingId}`;
  } else {
    await sql`UPDATE hive_memory SET last_accessed = NOW(), access_count = access_count + 1 WHERE id = ${op.existingId}`;
  }
}
