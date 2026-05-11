import type { Sql } from "postgres";
import type { ContextProvenanceEntry, MemoryContext } from "../adapters/types";
import { formatWithFreshness } from "./freshness";
import { findSimilar, type SimilarityResult } from "./embeddings";
import type { ModelCallerConfig } from "./model-caller";
import { createTaskContextProvenance } from "../provenance/task-context";

export interface InjectionQuery {
  roleSlug: string;
  hiveId: string;
  department: string | null;
  taskBrief: string;
  pgvectorEnabled: boolean;
  modelConfig?: ModelCallerConfig;
}

const MAX_ROLE_MEMORIES = 10;
const MAX_HIVE_MEMORIES = 10;
const MAX_INSIGHTS = 3;

export async function queryRelevantMemory(
  sql: Sql,
  query: InjectionQuery,
): Promise<MemoryContext> {
  // 1. Get semantic matches if pgvector is available
  let semanticHits: SimilarityResult[] = [];
  if (query.pgvectorEnabled) {
    semanticHits = await findSimilar(sql, {
      queryText: query.taskBrief,
      sourceTypes: ["role_memory", "hive_memory"],
      limit: 20,
      modelConfig: query.modelConfig,
      pgvectorEnabled: true,
      hiveId: query.hiveId,
    });
  }

  const semanticRoleIds = new Set(
    semanticHits.filter((h) => h.sourceType === "role_memory").map((h) => h.sourceId)
  );
  const semanticBizIds = new Set(
    semanticHits.filter((h) => h.sourceType === "hive_memory").map((h) => h.sourceId)
  );

  // 2. Query role memories (excluding superseded and restricted)
  const roleMemoryRows = await sql`
    SELECT id, content, confidence, updated_at, access_count, source_task_id
    FROM role_memory
    WHERE role_slug = ${query.roleSlug}
      AND hive_id = ${query.hiveId}
      AND superseded_by IS NULL
      AND sensitivity != 'restricted'
    ORDER BY updated_at DESC
    LIMIT ${MAX_ROLE_MEMORIES}
  `;

  const scoredRoleMemories = roleMemoryRows.map((r) => {
    const recencyScore = computeRecencyScore(r.updated_at as Date);
    const accessScore = Math.min((r.access_count as number) / 20, 0.3);
    const semanticBoost = semanticRoleIds.has(r.id as string) ? 0.4 : 0;
    const score = recencyScore + accessScore + semanticBoost;
    return {
      id: r.id as string,
      sourceTaskId: r.source_task_id as string | null,
      content: formatWithFreshness(r.content as string, r.updated_at as Date),
      confidence: r.confidence as number,
      updatedAt: r.updated_at as Date,
      score,
    };
  }).sort((a, b) => b.score - a.score).slice(0, 5);

  // 3. Query hive memories (excluding restricted)
  const hiveMemoryRows = await sql`
    SELECT id, content, category, confidence, updated_at, access_count, department, source_task_id
    FROM hive_memory
    WHERE hive_id = ${query.hiveId}
      AND superseded_by IS NULL
      AND sensitivity != 'restricted'
    ORDER BY updated_at DESC
    LIMIT ${MAX_HIVE_MEMORIES}
  `;

  const scoredHiveMemories = hiveMemoryRows.map((r) => {
    const recencyScore = computeRecencyScore(r.updated_at as Date);
    const accessScore = Math.min((r.access_count as number) / 20, 0.3);
    const semanticBoost = semanticBizIds.has(r.id as string) ? 0.4 : 0;
    const deptBoost = query.department && r.department === query.department ? 0.1 : 0;
    const score = recencyScore + accessScore + semanticBoost + deptBoost;
    return {
      id: r.id as string,
      sourceTaskId: r.source_task_id as string | null,
      content: formatWithFreshness(r.content as string, r.updated_at as Date),
      category: r.category as string,
      confidence: r.confidence as number,
      score,
    };
  }).sort((a, b) => b.score - a.score).slice(0, 5);

  // 4. Query insights (filtered by department and excluding restricted)
  const insightRows = query.department
    ? await sql`
        SELECT id, content, connection_type, confidence
        FROM insights
        WHERE hive_id = ${query.hiveId}
          AND status IN ('new', 'reviewed')
          AND confidence >= 0.6
          AND max_source_sensitivity != 'restricted'
          AND affected_departments @> ${sql.json([query.department])}
        ORDER BY priority ASC, created_at DESC
        LIMIT ${MAX_INSIGHTS}
      `
    : await sql`
        SELECT id, content, connection_type, confidence
        FROM insights
        WHERE hive_id = ${query.hiveId}
          AND status IN ('new', 'reviewed')
          AND confidence >= 0.6
          AND max_source_sensitivity != 'restricted'
        ORDER BY priority ASC, created_at DESC
        LIMIT ${MAX_INSIGHTS}
      `;

  // 5. Bump access_count for all injected memories
  const injectedRoleIds = scoredRoleMemories.map((m) => m.id);
  const injectedBizIds = scoredHiveMemories.map((m) => m.id);

  if (injectedRoleIds.length > 0) {
    await sql`
      UPDATE role_memory SET last_accessed = NOW(), access_count = access_count + 1
      WHERE id = ANY(${injectedRoleIds})
    `;
  }
  if (injectedBizIds.length > 0) {
    await sql`
      UPDATE hive_memory SET last_accessed = NOW(), access_count = access_count + 1
      WHERE id = ANY(${injectedBizIds})
    `;
  }

  const provenanceEntries: ContextProvenanceEntry[] = [
    ...scoredRoleMemories.map((memory) => ({
      sourceClass: "role_memory" as const,
      reference: `role_memory:${memory.id}`,
      sourceId: memory.id,
      sourceTaskId: memory.sourceTaskId,
      category: null,
    })),
    ...scoredHiveMemories.map((memory) => ({
      sourceClass: "hive_memory" as const,
      reference: `hive_memory:${memory.id}`,
      sourceId: memory.id,
      sourceTaskId: memory.sourceTaskId,
      category: memory.category,
    })),
    ...insightRows.map((insight) => {
      const id = insight.id as string;
      return {
        sourceClass: "insight" as const,
        reference: `insights:${id}`,
        sourceId: id,
        sourceTaskId: null,
        category: insight.connection_type as string,
      };
    }),
  ];

  // 6. Capacity
  const [capacityRow] = await sql`
    SELECT COUNT(*)::int AS count FROM role_memory
    WHERE role_slug = ${query.roleSlug} AND hive_id = ${query.hiveId}
      AND superseded_by IS NULL
  `;

  return {
    roleMemory: scoredRoleMemories.map((m) => ({
      content: m.content,
      confidence: m.confidence,
      updatedAt: m.updatedAt,
    })),
    hiveMemory: scoredHiveMemories.map((m) => ({
      content: m.content,
      category: m.category,
      confidence: m.confidence,
    })),
    insights: insightRows.map((r) => ({
      content: r.content as string,
      connectionType: r.connection_type as string,
      confidence: r.confidence as number,
    })),
    provenance: createTaskContextProvenance(provenanceEntries),
    capacity: (() => {
      const count = capacityRow?.count ?? 0;
      return count >= 160
        ? `${count}/200 ⚠ CAPACITY WARNING: Consider consolidating stale entries before adding new ones`
        : `${count}/200`;
    })(),
  };
}

function computeRecencyScore(updatedAt: Date): number {
  const daysSince = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince <= 7) return 0.5;
  if (daysSince <= 30) return 0.3;
  if (daysSince <= 90) return 0.15;
  return 0.05;
}
