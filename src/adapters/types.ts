import type { ClaimedTask } from "../dispatcher/types";

export interface RoleContext {
  roleMd: string | null;
  soulMd: string | null;
  toolsMd: string | null;
  slug: string;
  department: string | null;
}

export type ContextSourceClass =
  | "role_memory"
  | "hive_memory"
  | "insight"
  | "work_product"
  | "task"
  | "goal";

export interface ContextProvenanceEntry {
  sourceClass: ContextSourceClass;
  reference: string;
  sourceId: string;
  sourceTaskId?: string | null;
  category?: string | null;
}

export interface ContextProvenance {
  status: "available" | "none" | "unavailable";
  entries: ContextProvenanceEntry[];
  disclaimer: string;
}

export interface MemoryContext {
  roleMemory: { content: string; confidence: number; updatedAt: Date }[];
  hiveMemory: { content: string; category: string; confidence: number }[];
  insights: { content: string; connectionType: string; confidence: number }[];
  capacity: string;
  provenance?: ContextProvenance;
}

export interface SessionContext {
  task: ClaimedTask;
  roleTemplate: RoleContext;
  memoryContext: MemoryContext;
  skills: string[];
  standingInstructions: string[];
  goalContext: string | null;
  projectWorkspace: string | null;
  /**
   * True only when the task is explicitly associated with a project whose
   * projects.git_repo flag is true. Hive workspaces and repo-looking project
   * paths must not implicitly opt into git worktree provisioning.
   */
  gitBackedProject?: boolean;
  /** Canonical workspace resolved from hive/project before any per-task isolation. */
  baseProjectWorkspace?: string | null;
  /** Dispatcher-owned per-task workspace metadata. */
  workspaceIsolation?: TaskWorkspaceIsolationContext | null;
  /**
   * Per-task git worktree isolation context surfaced to adapters and the
   * supervisor. Optional and additive: absent on sessions that predate
   * worktree-aware spawn paths or that opt out of isolation entirely.
   */
  worktreeContext?: {
    baseWorkspace: string;
    effectiveWorkspace: string;
    branch: string;
    isolationStatus: "active" | "skipped" | "disabled";
    worktreePath: string;
    createdAt: Date;
    reusedAt: Date;
    failureReason: string | null;
  };
  hiveSlug?: string | null;
  /** Rendered "## Hive Context" markdown (name/type/about/mission/targets).
   *  Sits between Identity and Task in the system prompt. Empty string when
   *  the hive row is missing. */
  hiveContext?: string;
  model: string;
  fallbackModel: string | null;
  /**
   * Which adapter to use if the primary is unhealthy (e.g. local Ollama
   * offline, Claude API rate-limited). NULL = use the same adapter as the
   * primary for fallback — legacy same-adapter rate-limit behaviour.
   */
  fallbackAdapterType?: string | null;
  /** Primary adapter the dispatcher resolved for this session. */
  primaryAdapterType?: string | null;
  /** Canonical owning hive workspace used for hive-scoped artifact storage. */
  hiveWorkspacePath?: string | null;
  /** Image work_products authorized for this task's downstream context. */
  imageWorkProducts?: ImageWorkProductContext[];
  credentials: Record<string, string>;
  /**
   * Per-role tool scope from role_templates.tools_config. NULL = inherit
   * runtime CLI defaults (preserves pre-tools-config behaviour). When set,
   * adapters pass the strict per-spawn flags so the role only sees these
   * MCPs and (optionally) only this set of built-in tools.
   */
  toolsConfig?: { mcps?: string[]; allowedTools?: string[] } | null;
  /**
   * Shared prompt assembly policy. Executor roles default to lean startup
   * context so adapters render task essentials eagerly and reference bulky
   * memory/history/evidence instead of replaying it raw.
   */
  contextPolicy?: {
    mode: "lean" | "full";
    reason: "executor_default" | "non_executor" | "explicit" | "review_replan_cost_control";
  };
}

export type TaskWorkspaceIsolationStatus = "active" | "skipped" | "failed";

export interface TaskWorkspaceIsolationContext {
  status: TaskWorkspaceIsolationStatus;
  baseWorkspacePath: string | null;
  worktreePath: string | null;
  branchName: string | null;
  isolationActive: boolean;
  reused: boolean;
  reason: string | null;
}

export interface ImageWorkProductContext {
  workProductId: string;
  taskId: string;
  roleSlug: string;
  path: string;
  diskPath: string;
  imageRead: {
    type: "local_image";
    path: string;
    mimeType: "image/png" | "image/jpeg";
  };
  mimeType: "image/png" | "image/jpeg";
  dimensions: { width: number; height: number };
  model: {
    name: string | null;
    snapshot: string | null;
  };
  usage: {
    promptTokens: number | null;
    outputTokens: number | null;
    costCents: number | null;
  };
  originalImageBrief: {
    taskTitle: string;
    taskBrief: string;
    prompt: string | null;
  };
  metadata: Record<string, unknown> | null;
}

export interface AdapterResult {
  success: boolean;
  output: string;
  /** Persistent adapter session id that can be reused for task rework. */
  sessionId?: string | null;
  failureReason?: string;
  runtimeWarnings?: string[];
  runtimeDiagnostics?: {
    codexEmptyOutput?: CodexEmptyOutputDiagnostic;
  };
  failureKind?: "execution_slice_exceeded" | "spawn_error" | "unsafe_runtime_failure" | "unknown";
  tokensInput?: number;
  freshInputTokens?: number;
  cachedInputTokens?: number;
  cachedInputTokensKnown?: boolean;
  totalContextTokens?: number;
  estimatedBillableCostCents?: number;
  tokensOutput?: number;
  costCents?: number;
  modelUsed?: string;
  artifacts?: AdapterArtifact[];
}

export type ProbeHealthStatus = "healthy" | "unhealthy";

export type ProbeFailureClass =
  | "auth"
  | "quota"
  | "scope"
  | "region"
  | "runtime_session"
  | "gpu_oom"
  | "gateway_retired"
  | "unavailable"
  | "timeout"
  | "unknown";

export interface AdapterProbeCredential {
  provider: string;
  baseUrl?: string | null;
  fingerprint?: string | null;
  secrets: Record<string, string>;
}

export interface ProbeReason {
  code: string;
  message: string;
  failureClass: ProbeFailureClass | null;
  retryable: boolean;
}

export interface ProbeResult {
  healthy: boolean;
  status: ProbeHealthStatus;
  reason: ProbeReason;
  failureClass: ProbeFailureClass | null;
  latencyMs: number;
  costEstimateUsd: number;
}

export interface AdapterProbe {
  probe(modelId: string, credential: AdapterProbeCredential): Promise<ProbeResult>;
}

export interface CodexEmptyOutputDiagnostic {
  kind: "codex_empty_output";
  schemaVersion: 1;
  codexEmptyOutput: true;
  exitCode: number | null;
  effectiveAdapter: string | null;
  adapterOverride: string | null;
  modelSlug: string;
  modelProviderMismatchDetected: boolean;
  cwd: string;
  taskWorkspace: string | null;
  rolloutSignaturePresent: boolean;
  stderrTail: string;
  terminalEvents: Array<{
    type: "turn.failed" | "error";
    ids: Record<string, string>;
    error: {
      code?: string;
      message?: string;
      type?: string;
      id?: string;
    };
  }>;
  truncated: boolean;
  truncationMarker?: "[...TRUNCATED_CODEX_EMPTY_OUTPUT_DIAGNOSTIC_8192_BYTES]";
}

export interface AdapterArtifact {
  kind: "image";
  path: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  modelName: string;
  modelSnapshot: string;
  promptTokens?: number;
  outputTokens?: number;
  costCents?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Called by adapters for each output chunk as it arrives from the subprocess.
 * The dispatcher provides this callback; it writes the chunk to task_logs and
 * broadcasts via pg_notify. Adapters must await all pending ChunkCallback
 * promises before their execute() promise resolves so that the dispatcher can
 * safely write the terminal "done" chunk afterwards.
 */
export type ChunkCallback = (chunk: {
  text: string;
  type: "stdout" | "stderr" | "status" | "diagnostic" | "done";
}) => Promise<void>;

export interface Adapter extends AdapterProbe {
  /** Whether this adapter supports persistent multi-turn sessions */
  supportsPersistence: boolean;
  translate(ctx: SessionContext): string;
  /**
   * Execute a task. If `onChunk` is provided, call it for each line/buffer of
   * stdout/stderr as it arrives rather than only on process close.
   * All onChunk calls must be awaited before execute() resolves.
   */
  execute(ctx: SessionContext, onChunk?: ChunkCallback): Promise<AdapterResult>;
  /** Start a persistent session. Only available if supportsPersistence is true. */
  startSession?(ctx: SessionContext): Promise<{ sessionId: string }>;
  /** Send a message to an existing persistent session. */
  sendMessage?(sessionId: string, message: string, ctx: SessionContext, onChunk?: ChunkCallback): Promise<AdapterResult>;
  /** Terminate a persistent session. */
  terminateSession?(sessionId: string): Promise<void>;
}
