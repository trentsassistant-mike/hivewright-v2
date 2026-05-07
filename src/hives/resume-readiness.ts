import type { Sql } from "postgres";
import { adapterSupports } from "@/adapters/capabilities";
import {
  canonicalModelIdForAdapter,
} from "@/model-health/model-identity";
import {
  getModelHealthProbePolicy,
} from "@/model-health/probe-policy";
import {
  checkModelSpawnHealth,
  type ModelSpawnHealthDecision,
  type ModelSpawnHealthInput,
} from "@/model-health/spawn-gate";
import { classifyProbeFreshness } from "@/model-health/probe-policy";
import {
  getHiveCreationPause,
  type HiveCreationPause,
} from "@/operations/creation-pause";

export type ResumeReadinessStatus = "running" | "ready" | "blocked";

export type ResumeReadinessBlockerCode =
  | "enabled_schedules"
  | "runnable_tasks"
  | "pending_decisions"
  | "no_enabled_models"
  | "model_health_blocked";

export interface ResumeReadinessBlocker {
  code: ResumeReadinessBlockerCode;
  label: string;
  count: number;
  detail: string;
}

export interface ResumeModelRouteReadiness {
  provider: string;
  adapterType: string;
  modelId: string;
  canRun: boolean;
  category: "runnable" | "stale" | "unavailable" | "on_demand";
  reason: ModelSpawnHealthDecision["reason"];
  status?: string | null;
  lastProbedAt?: string | null;
  nextProbeAt?: string | null;
  failureReason?: string | null;
  freshness?: "unknown" | "fresh" | "due";
}

export interface ResumeSessionRouteReadiness {
  provider: string;
  adapterType: string;
  modelId: string;
  persistentSessions: boolean;
}

export interface HiveResumeReadiness {
  status: ResumeReadinessStatus;
  canResumeSafely: boolean;
  counts: {
    enabledSchedules: number;
    runnableTasks: number;
    pendingDecisions: number;
    unresolvableTasks: number;
  };
  models: {
    enabled: number;
    ready: number;
    blocked: number;
    stale: number;
    unavailable: number;
    onDemand: number;
    blockedRoutes: ResumeModelRouteReadiness[];
  };
  sessions: {
    persistentRoutes: number;
    fallbackRoutes: number;
    routes: ResumeSessionRouteReadiness[];
  };
  blockers: ResumeReadinessBlocker[];
  checkedAt: string;
}

export type ModelReadinessChecker = (
  sql: Sql,
  input: ModelSpawnHealthInput,
) => Promise<ModelSpawnHealthDecision>;

interface HiveModelRouteRow {
  provider: string;
  adapter_type: string;
  model_id: string;
  capabilities: string[];
}

interface ResumeCountsRow {
  enabled_schedules: string | number;
  runnable_tasks: string | number;
  pending_decisions: string | number;
  unresolvable_tasks: string | number;
}

export async function getHiveResumeReadiness(
  sql: Sql,
  input: {
    hiveId: string;
    now?: Date;
    creationPause?: HiveCreationPause;
    checkModelHealth?: ModelReadinessChecker;
  },
): Promise<HiveResumeReadiness> {
  const now = input.now ?? new Date();
  const creationPause =
    input.creationPause ?? await getHiveCreationPause(sql, input.hiveId);

  const [countsRow] = await sql<ResumeCountsRow[]>`
    SELECT
      (SELECT COUNT(*) FROM schedules
        WHERE hive_id = ${input.hiveId}::uuid
          AND enabled = true)::int AS enabled_schedules,
      (SELECT COUNT(*) FROM tasks
        WHERE hive_id = ${input.hiveId}::uuid
          AND status IN ('pending', 'active', 'claimed', 'running', 'in_review'))::int AS runnable_tasks,
      (SELECT COUNT(*) FROM decisions
        WHERE hive_id = ${input.hiveId}::uuid
          AND status = 'pending'
          AND kind = 'decision'
          AND is_qa_fixture = false)::int AS pending_decisions,
      (SELECT COUNT(*) FROM tasks
        WHERE hive_id = ${input.hiveId}::uuid
          AND status = 'unresolvable'
          AND NOT EXISTS (
            SELECT 1
            FROM tasks child
            WHERE child.parent_task_id = tasks.id
              AND child.assigned_to = 'doctor'
              AND child.status IN ('pending', 'active', 'claimed', 'running', 'in_review', 'blocked')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM decisions d
            WHERE d.task_id = tasks.id
              AND d.status IN ('ea_review', 'pending', 'resolved')
              AND d.kind IN ('unresolvable_task_triage', 'supervisor_flagged', 'quality_doctor_recommendation')
          ))::int AS unresolvable_tasks
  `;

  const counts = {
    enabledSchedules: toCount(countsRow?.enabled_schedules),
    runnableTasks: toCount(countsRow?.runnable_tasks),
    pendingDecisions: toCount(countsRow?.pending_decisions),
    unresolvableTasks: toCount(countsRow?.unresolvable_tasks),
  };

  const modelRows = await sql<HiveModelRouteRow[]>`
    SELECT provider, adapter_type, model_id, capabilities
    FROM hive_models
    WHERE hive_id = ${input.hiveId}::uuid
      AND enabled = true
    ORDER BY fallback_priority ASC, created_at ASC
  `;

  const checkModelHealth = input.checkModelHealth ?? checkModelSpawnHealth;
  const sessionReadiness = summarizeSessionRoutes(modelRows);
  const modelReadiness = await Promise.all(
    modelRows.map(async (model): Promise<ResumeModelRouteReadiness> => {
      const health = await checkModelHealth(sql, {
        hiveId: input.hiveId,
        adapterType: model.adapter_type,
        modelId: model.model_id,
        now,
      });
      const probeMode = getModelHealthProbePolicy({
        provider: model.provider,
        adapterType: model.adapter_type,
        modelId: canonicalModelIdForAdapter(model.adapter_type, model.model_id),
        capabilities: model.capabilities ?? [],
        sampleCostUsd: null,
      }).mode;
      return {
        provider: model.provider,
        adapterType: model.adapter_type,
        modelId: model.model_id,
        canRun: health.canRun,
        category: classifyReadinessCategory(health, probeMode),
        reason: health.reason,
        status: health.status ?? null,
        lastProbedAt: health.lastProbedAt ? health.lastProbedAt.toISOString() : null,
        nextProbeAt: health.nextProbeAt ? health.nextProbeAt.toISOString() : null,
        failureReason: health.failureReason ?? null,
        freshness: classifyProbeFreshness(health.nextProbeAt ?? null, now),
      };
    }),
  );

  if (!creationPause.paused) {
    return {
      status: "running",
      canResumeSafely: false,
      counts,
      models: summarizeModels(modelReadiness),
      sessions: sessionReadiness,
      blockers: [],
      checkedAt: now.toISOString(),
    };
  }

  const blockers = buildBlockers(counts, modelReadiness);
  return {
    status: blockers.length === 0 ? "ready" : "blocked",
    canResumeSafely: blockers.length === 0,
    counts,
    models: summarizeModels(modelReadiness),
    sessions: sessionReadiness,
    blockers,
    checkedAt: now.toISOString(),
  };
}

function summarizeModels(modelReadiness: ResumeModelRouteReadiness[]) {
  const runnable = modelReadiness.filter((model) => model.category === "runnable");
  const stale = modelReadiness.filter((model) => model.category === "stale");
  const unavailable = modelReadiness.filter((model) => model.category === "unavailable");
  const onDemand = modelReadiness.filter((model) => model.category === "on_demand");
  const blockedRoutes = [...stale, ...unavailable];
  return {
    enabled: modelReadiness.length,
    ready: runnable.length,
    blocked: blockedRoutes.length,
    stale: stale.length,
    unavailable: unavailable.length,
    onDemand: onDemand.length,
    blockedRoutes,
  };
}

function summarizeSessionRoutes(modelRows: HiveModelRouteRow[]): HiveResumeReadiness["sessions"] {
  const routes = modelRows.map((model) => ({
    provider: model.provider,
    adapterType: model.adapter_type,
    modelId: model.model_id,
    persistentSessions: adapterSupports(model.adapter_type, "persistentSessions"),
  }));
  const persistentRoutes = routes.filter((route) => route.persistentSessions).length;
  return {
    persistentRoutes,
    fallbackRoutes: routes.length - persistentRoutes,
    routes,
  };
}

function buildBlockers(
  counts: HiveResumeReadiness["counts"],
  modelReadiness: ResumeModelRouteReadiness[],
): ResumeReadinessBlocker[] {
  const blockers: ResumeReadinessBlocker[] = [];
  if (counts.enabledSchedules > 0) {
    blockers.push({
      code: "enabled_schedules",
      label: "Schedules are still enabled",
      count: counts.enabledSchedules,
      detail: "Pause should disable schedules before resume is considered safe.",
    });
  }
  if (counts.runnableTasks > 0) {
    blockers.push({
      code: "runnable_tasks",
      label: "Runnable work is already queued",
      count: counts.runnableTasks,
      detail: "Clear or intentionally review queued work before resuming autonomy.",
    });
  }
  if (counts.pendingDecisions > 0) {
    blockers.push({
      code: "pending_decisions",
      label: "Owner decisions are pending",
      count: counts.pendingDecisions,
      detail: "Resolve owner-tier decisions before allowing autonomous follow-up.",
    });
  }
  if (modelReadiness.length === 0) {
    blockers.push({
      code: "no_enabled_models",
      label: "No enabled models",
      count: 0,
      detail: "Enable and probe at least one model before resuming work.",
    });
    return blockers;
  }

  const blockedModels = modelReadiness.filter((model) => (
    model.category === "stale" || model.category === "unavailable"
  )).length;
  if (blockedModels > 0) {
    blockers.push({
      code: "model_health_blocked",
      label: "Models need fresh health evidence",
      count: blockedModels,
      detail: "Every enabled model needs a fresh healthy probe before the dispatcher can spawn it.",
    });
  }
  return blockers;
}

function classifyReadinessCategory(
  health: ModelSpawnHealthDecision,
  probeMode: "automatic" | "on_demand",
): ResumeModelRouteReadiness["category"] {
  if (probeMode === "on_demand") return "on_demand";
  if (health.canRun) return "runnable";
  if (health.reason === "health_probe_stale") return "stale";
  return "unavailable";
}

function toCount(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
