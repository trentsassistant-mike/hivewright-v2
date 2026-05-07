export type FreshnessLevel = "fresh" | "aging" | "stale";

export type OperationType = "ADD" | "UPDATE" | "DELETE" | "NOOP";
export type MemoryStore = "role_memory" | "hive_memory";

export interface MemoryOperation {
  operation: OperationType;
  store: MemoryStore;
  content?: string;
  confidence?: number;
  category?: string;
  existingId?: string;
  reason?: string;
}

export interface ExtractionResult {
  facts: MemoryOperation[];
  rawResponse: string;
}

export interface ScoredMemory {
  id: string;
  content: string;
  confidence: number;
  updatedAt: Date;
  score: number;
  freshnessLevel: FreshnessLevel;
  store: MemoryStore;
  category?: string;
  roleSlug?: string;
}

export interface ExtractionContext {
  workProductContent: string;
  roleSlug: string;
  hiveId: string;
  department: string | null;
  taskId: string;
  existingRoleMemories: { id: string; content: string; confidence: number }[];
  existingHiveMemories: { id: string; content: string; confidence: number; category: string }[];
}
