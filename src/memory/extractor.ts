import type { Sql } from "postgres";
import type { ExtractionContext, ExtractionResult, MemoryOperation } from "./types";
import { callGenerationModel, type ModelCallerConfig, getDefaultConfig } from "./model-caller";
import { applyMemoryOperations, type OperationResult } from "./operations";

export function buildExtractionPrompt(ctx: ExtractionContext): string {
  const sections: string[] = [];

  sections.push(`You are a fact extraction system. Given a work product and existing memories, extract discrete facts.

For each fact, decide:
- ADD: Genuinely new knowledge not in existing memories
- UPDATE: Refines or corrects an existing memory (provide existingId)
- DELETE: Contradicts an existing memory (provide existingId)
- NOOP: Already known in existing memories (provide existingId)

Classify each fact as either "role_memory" (specific to how this role does its job) or "hive_memory" (general hive knowledge).
For hive_memory, provide a category: market | operations | competitor | customer | financial | seasonal | vendor | general`);

  sections.push(`## Work Product
Role: ${ctx.roleSlug}
Department: ${ctx.department || "general"}
Content:
${ctx.workProductContent}`);

  if (ctx.existingRoleMemories.length > 0) {
    sections.push("## Existing Role Memories");
    for (const m of ctx.existingRoleMemories) {
      sections.push(`- [id: ${m.id}] ${m.content} (confidence: ${m.confidence})`);
    }
  } else {
    sections.push("## Existing Role Memories\nNone");
  }

  if (ctx.existingHiveMemories.length > 0) {
    sections.push("## Existing Hive Memories");
    for (const m of ctx.existingHiveMemories) {
      sections.push(`- [id: ${m.id}] [${m.category}] ${m.content} (confidence: ${m.confidence})`);
    }
  } else {
    sections.push("## Existing Hive Memories\nNone");
  }

  sections.push(`## Output Format
Respond with ONLY a JSON object (no other text):
{
  "facts": [
    {
      "operation": "ADD|UPDATE|DELETE|NOOP",
      "store": "role_memory|hive_memory",
      "content": "the fact (for ADD/UPDATE)",
      "confidence": 0.0-1.0,
      "category": "market|operations|competitor|customer|financial|seasonal|vendor|general (hive_memory only)",
      "existingId": "id of existing memory (for UPDATE/DELETE/NOOP)",
      "reason": "why (for DELETE/NOOP)"
    }
  ]
}

Be selective. Only extract facts that would be useful for future tasks. Skip trivial observations.`);

  return sections.join("\n\n");
}

export function parseExtractionResponse(response: string): ExtractionResult {
  let cleaned = response.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed.facts || !Array.isArray(parsed.facts)) {
      return { facts: [], rawResponse: response };
    }
    const validFacts: MemoryOperation[] = parsed.facts
      .filter((f: Record<string, unknown>) =>
        f.operation && ["ADD", "UPDATE", "DELETE", "NOOP"].includes(f.operation as string)
      )
      .map((f: Record<string, unknown>) => ({
        operation: f.operation as MemoryOperation["operation"],
        store: (f.store as MemoryOperation["store"]) || "role_memory",
        content: f.content as string | undefined,
        confidence: typeof f.confidence === "number" ? f.confidence : undefined,
        category: f.category as string | undefined,
        existingId: f.existingId as string | undefined,
        reason: f.reason as string | undefined,
      }));
    return { facts: validFacts, rawResponse: response };
  } catch {
    return { facts: [], rawResponse: response };
  }
}

export interface ExtractAndStoreResult {
  extraction: ExtractionResult;
  operationResults: OperationResult[];
}

export async function extractAndStore(
  sql: Sql,
  ctx: ExtractionContext,
  modelConfig: ModelCallerConfig = getDefaultConfig(),
): Promise<ExtractAndStoreResult> {
  const prompt = buildExtractionPrompt(ctx);
  const response = await callGenerationModel(prompt, modelConfig);
  const extraction = parseExtractionResponse(response);
  if (extraction.facts.length === 0) {
    return { extraction, operationResults: [] };
  }
  const operationResults = await applyMemoryOperations(sql, extraction.facts, {
    hiveId: ctx.hiveId,
    roleSlug: ctx.roleSlug,
    sourceTaskId: ctx.taskId,
  });
  return { extraction, operationResults };
}
