import type { HiveResumeReadiness } from "@/hives/resume-readiness";
import type { HiveCreationPause } from "@/operations/creation-pause";

export type FindingKind =
  | "unsatisfied_completion"
  | "stalled_task"
  | "dormant_goal"
  | "goal_lifecycle_gap"
  | "aging_decision"
  | "recurring_failure"
  | "orphan_output";

export type FindingSeverity = "info" | "warn" | "critical";

export interface SupervisorFindingRef {
  taskId?: string;
  goalId?: string;
  decisionId?: string;
  role?: string;
}

export interface SupervisorFinding {
  id: string;
  kind: FindingKind;
  severity: FindingSeverity;
  ref: SupervisorFindingRef;
  summary: string;
  detail: Record<string, unknown>;
}

export interface HiveHealthMetrics {
  openTasks: number;
  activeGoals: number;
  openDecisions: number;
  tasksCompleted24h: number;
  tasksFailed24h: number;
}

export interface HiveTargetContext {
  open: number;
  achieved: number;
  abandoned: number;
  overdueOpen: number;
  dueSoonOpen: number;
  openTargets: Array<{
    id: string;
    title: string;
    targetValue: string | null;
    deadline: string | null;
    sortOrder: number;
  }>;
}

export interface HiveHealthReport {
  hiveId: string;
  scannedAt: string;
  fingerprint?: string;
  findings: SupervisorFinding[];
  metrics: HiveHealthMetrics;
  operatingContext?: {
    creationPause: HiveCreationPause;
    resumeReadiness: HiveResumeReadiness;
    targets: HiveTargetContext;
  };
}

export interface SupervisorDecisionOption {
  key: string;
  label: string;
  consequence?: string;
  description?: string;
  response?: string;
  canonicalResponse?: string;
  canonical_response?: string;
}

export type SupervisorAction =
  | {
      kind: "spawn_followup";
      originalTaskId: string;
      assignedTo: string;
      title: string;
      brief: string;
      qaRequired?: boolean;
    }
  | { kind: "wake_goal"; goalId: string; reasoning: string }
  | {
      kind: "create_decision";
      tier: 2 | 3;
      title: string;
      context: string;
      recommendation?: string;
      options?: SupervisorDecisionOption[];
    }
  | { kind: "close_task"; taskId: string; note: string }
  | { kind: "mark_unresolvable"; taskId: string; reason: string }
  | { kind: "log_insight"; category: string; content: string }
  | { kind: "noop"; reasoning: string };

export type SupervisorActionKind = SupervisorAction["kind"];

export interface SupervisorActions {
  summary: string;
  findings_addressed: string[];
  actions: SupervisorAction[];
}

export type AppliedStatus = "applied" | "skipped" | "error";

export interface AppliedOutcome {
  action: SupervisorAction;
  status: AppliedStatus;
  detail: string;
}

export interface ApplySupervisorActionsContext {
  report?: HiveHealthReport;
}

export type ParseSupervisorActionsResult =
  | { ok: true; value: SupervisorActions }
  | { ok: false; error: string; kind: "no_block" | "malformed" | "invalid_shape" };
