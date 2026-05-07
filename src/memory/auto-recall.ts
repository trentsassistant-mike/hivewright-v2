import type { Sql } from "postgres";
import { queryRelevantMemory } from "./injection";

export interface AutoRecallConfig {
  enabled: boolean;
  intervalCalls: number; // inject every N calls (default 10)
  maxTokens: number; // max tokens for recall injection (default 200)
}

export function getDefaultAutoRecallConfig(): AutoRecallConfig {
  return { enabled: true, intervalCalls: 10, maxTokens: 200 };
}

/**
 * Build a recall injection message based on recent activity.
 * Called by adapters that support mid-execution injection.
 */
export async function buildRecallInjection(
  sql: Sql,
  params: {
    roleSlug: string;
    hiveId: string;
    department: string | null;
    recentActivity: string; // summary of what the agent has been doing
  },
): Promise<string | null> {
  const memory = await queryRelevantMemory(sql, {
    roleSlug: params.roleSlug,
    hiveId: params.hiveId,
    department: params.department,
    taskBrief: params.recentActivity,
    pgvectorEnabled: false, // keep it fast
  });

  const parts: string[] = [];

  if (memory.roleMemory.length > 0) {
    parts.push("**Recall — relevant knowledge:**");
    for (const m of memory.roleMemory.slice(0, 2)) {
      parts.push(`- ${m.content}`);
    }
  }

  if (memory.hiveMemory.length > 0) {
    for (const m of memory.hiveMemory.slice(0, 2)) {
      parts.push(`- [${m.category}] ${m.content}`);
    }
  }

  if (parts.length <= 1) return null; // Only header, no content
  return parts.join("\n");
}
