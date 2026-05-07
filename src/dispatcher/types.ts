export interface DispatcherConfig {
  pollIntervalMs: number; // 30000 (30s)
  watchdogIntervalMs: number; // 30000 (30s)
  scheduleIntervalMs: number; // 60000 (60s)
  heartbeatTimeoutMs: number; // 300000 (5 min)
  /**
   * Hard ceiling on a single task's wall-clock runtime. Heartbeat-only
   * detection misses agents that emit periodic stderr (e.g. OpenClaw gateway
   * timeouts) but never actually finish — they look "alive" forever.
   * Default 2 hours; can be raised per-deployment via env if a workflow
   * legitimately needs longer.
   */
  maxTaskRuntimeMs: number;
  maxRetries: number; // 3
  maxDoctorAttempts: number; // 2
  sprintCheckIntervalMs: number;  // 900000 (15 min)
  supervisorWakeReconciliationIntervalMs: number; // 300000 (5 min)
  synthesisIntervalMs: number; // 7200000 (2 hr)
  maxConcurrentTasks: number; // 5
  modelHealthRenewalIntervalMs: number; // 300000 (5 min)
}

export const DEFAULT_CONFIG: DispatcherConfig = {
  pollIntervalMs: 30_000,
  watchdogIntervalMs: 30_000,
  scheduleIntervalMs: 60_000,
  heartbeatTimeoutMs: 300_000,
  maxTaskRuntimeMs: 7_200_000, // 2 hours
  maxRetries: 3,
  maxDoctorAttempts: 2,
  sprintCheckIntervalMs: 900_000,
  supervisorWakeReconciliationIntervalMs: 300_000,
  synthesisIntervalMs: 7_200_000,
  maxConcurrentTasks: 5,
  modelHealthRenewalIntervalMs: 300_000,
};

export type TaskStatus =
  | "pending"
  | "active"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked"
  | "in_review"
  | "unresolvable";

export interface ClaimedTask {
  id: string;
  hiveId: string;
  assignedTo: string;
  createdBy: string;
  status: TaskStatus;
  priority: number;
  title: string;
  brief: string;
  parentTaskId: string | null;
  goalId: string | null;
  sprintNumber: number | null;
  qaRequired: boolean;
  acceptanceCriteria: string | null;
  retryCount: number;
  doctorAttempts: number;
  failureReason: string | null;
  adapterOverride?: string | null;
  modelOverride?: string | null;
  projectId: string | null;
}
