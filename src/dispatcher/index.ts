import "dotenv/config";
import postgres, { type Sql } from "postgres";
import path from "path";
import { createTaskListener, type TaskListener } from "./listener";
import { claimNextTask, completeTask, blockTask } from "./task-claimer";
import { handleTaskFailureAndDoctor, FailureCategory } from "./failure-handler";
import {
  findStuckTasks,
  findDeadEndReviewTasks,
  findStuckBlockedTasks,
  recoverInterruptedActiveTasks,
} from "./watchdog";
import { checkAndFireSchedules } from "./schedule-timer";
import { runScheduledModelDiscovery } from "./model-discovery-schedule";
import { runSystemModelHealthRenewal } from "./model-health-renewal";
import { recordTaskLifecycleTransitionBestEffort } from "@/audit/task-lifecycle";

import {
  findNewGoals,
  findCompletedSprintsForWakeUp,
  claimSprintWakeUp,
  revertSprintWakeUp,
  findOrphanedWakeUps,
  withGoalSupervisorWakeLock,
} from "./goal-lifecycle";
import {
  createSupervisorWakeReconciliationState,
  runSupervisorWakeReconciliation,
  type SupervisorWakeReconciliationState,
} from "./supervisor-wake-reconciliation";
import { buildSupervisorInitialPrompt } from "../goals/supervisor-session";
import { hiveGoalWorkspacePath } from "../hives/workspace-root";
import { syncRoleLibrary } from "../roles/sync";
import { watchRoleLibrary } from "../roles/watcher";
import { watchBundleForRestart, type BundleWatcherHandle } from "./bundle-watcher";
import { spawn } from "child_process";
import { DEFAULT_CONFIG, type DispatcherConfig, type ClaimedTask } from "./types";
import {
  calculateDynamicConcurrencyCap,
  normalizeDynamicConcurrencyConfig,
  readLocalCapacitySnapshot,
} from "./concurrency-controller";
import type { FSWatcher } from "chokidar";
import { buildSessionContext } from "./session-builder";
import { provisionTaskWorkspace } from "./worktree-manager";
import { runPreFlightChecks } from "./pre-flight";
import { validateBrief } from "./pre-task-qa";
import { checkDispatcherModelRouteHealth } from "./adapter-health";
import { decideProviderFailoverRoute } from "./provider-failover";
import { ClaudeCodeAdapter } from "../adapters/claude-code";
import { adapterSupports } from "../adapters/capabilities";
import type { Adapter } from "../adapters/types";
import {
  buildCodexEmptyOutputDiagnostic,
  collectCodexAgentTexts,
  detectCodexModelProviderMismatch,
  isCodexRolloutRegistrationFailure,
} from "../adapters/codex";
import { emitBinaryWorkProduct, emitWorkProduct, shouldEmitWorkProduct } from "../work-products/emitter";
import { writeTaskLog } from "./task-log-writer";
import { recordTaskCost, checkGoalBudget, checkAiBudget } from "./cost-tracker";
import { calculateCostCents } from "../adapters/provider-config";
import { routeToQa, processQaResult, notifyGoalSupervisorOfQaFailure, parseQaVerdict } from "./qa-router";
import {
  buildQaReworkPrompt,
  findReusableExecutionCapsule,
  markCapsuleCompleted,
  upsertExecutionCapsule,
} from "./execution-capsules";
import { extractAndStore } from "../memory/extractor";
import { checkPgvectorAvailable, initializeEmbeddings, storeEmbedding } from "../memory/embeddings";
import { shouldRunSynthesis, runSynthesis } from "../memory/synthesis";
import { getDefaultConfig as getModelConfig } from "../memory/model-caller";
import type { ExtractionContext } from "../memory/types";
import { buildSessionContextProvenance, writeTaskContextProvenanceLog } from "../provenance/task-context";
import { runInsightCurator } from "../insights/curator";
import { emitTaskEvent } from "./event-emitter";
import { sendNotification } from "../notifications/sender";
import { pruneStaleGoalSupervisors } from "../openclaw/goal-supervisor-cleanup";
import { buildGoalCreatedNotificationMessage } from "./goal-notification";
import {
  findPendingOwnerDecisionComments,
  mirrorOwnerDecisionCommentToGoalComment,
} from "../decisions/owner-comment-wake";
import { assertDispatcherSchemaVersion } from "./schema-version";
import {
  createDefaultDashboardHealerDeps,
  runDashboardHealerTick,
  type DashboardHealerState,
} from "./dashboard-healer";
import { OutboundNotifier } from "./notifier";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://hivewright@localhost:5432/hivewrightv2";
const CODEX_RUNTIME_CONTEXT_BYTE_CAP = 16_384;
const MODEL_DISCOVERY_INTERVAL_MS = 60 * 60 * 1000;

type StructuredDoctorDiagnosisTask = Pick<
  ClaimedTask,
  "assignedTo" | "createdBy" | "id" | "parentTaskId" | "title"
>;

export function isQualityDoctorDiagnosisTask(
  task: Pick<ClaimedTask, "createdBy" | "title">,
): boolean {
  return task.createdBy === "quality-doctor" || task.title.includes("Quality diagnosis:");
}

function appendBoundedRuntimeContext(current: string, next: string): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= CODEX_RUNTIME_CONTEXT_BYTE_CAP) return combined;
  const buffer = Buffer.from(combined, "utf8");
  return buffer
    .subarray(Math.max(0, buffer.length - CODEX_RUNTIME_CONTEXT_BYTE_CAP))
    .toString("utf8");
}

function parseExitCode(failureReason: string | undefined): number | null {
  if (!failureReason) return null;
  const match = failureReason.match(/\b(?:code|Code)\s+(\d+)\b/);
  return match ? Number(match[1]) : null;
}

export async function applyStructuredDoctorDiagnosis(
  sql: Sql,
  task: StructuredDoctorDiagnosisTask,
  output: string,
): Promise<boolean> {
  if (task.assignedTo !== "doctor" || !task.parentTaskId) return false;

  if (isQualityDoctorDiagnosisTask(task)) {
    const { parseQualityDoctorDiagnosis, applyQualityDoctorDiagnosis } =
      await import("../quality/doctor");
    const diagnosis = parseQualityDoctorDiagnosis(output);
    if (diagnosis) {
      await applyQualityDoctorDiagnosis(sql, task.parentTaskId, diagnosis);
      return true;
    }
  }

  const { parseDoctorDiagnosis, applyDoctorDiagnosis, escalateMalformedDiagnosis } =
    await import("../doctor");
  const parseResult = parseDoctorDiagnosis(output);
  if (parseResult.ok) {
    try {
      await applyDoctorDiagnosis(sql, task.parentTaskId, parseResult.diagnosis);
      console.log(
        `[dispatcher] Applied doctor diagnosis (${parseResult.diagnosis.action}) to parent task ${task.parentTaskId}`,
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[dispatcher] applyDoctorDiagnosis failed for parent ${task.parentTaskId}: ${msg}`,
      );
      await escalateMalformedDiagnosis(
        sql, task.parentTaskId,
        `applyDoctorDiagnosis threw: ${msg}`, output,
      );
      return true;
    }
  }

  if (parseResult.kind === "no_block") {
    console.warn(
      `[dispatcher] Doctor task ${task.id} produced no structured diagnosis; falling through to legacy shim for parent ${task.parentTaskId}.`,
    );
    return false;
  }

  console.warn(
    `[dispatcher] Doctor diagnosis parse failed for task ${task.id}: ${parseResult.reason}`,
  );
  await escalateMalformedDiagnosis(
    sql, task.parentTaskId, parseResult.reason, output,
  );
  return true;
}

export class Dispatcher {
  private sql: ReturnType<typeof postgres>;
  private config: DispatcherConfig;
  private shuttingDown = false;
  private activeTasks = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private modelDiscoveryTimer: NodeJS.Timeout | null = null;
  private sprintCheckTimer: NodeJS.Timeout | null = null;
  private supervisorWakeReconciliationTimer: NodeJS.Timeout | null = null;
  private taskListener: TaskListener | null = null;
  private roleWatcher: FSWatcher | null = null;
  private synthesisTimer: NodeJS.Timeout | null = null;
  private credentialCheckTimer: NodeJS.Timeout | null = null;
  private escalationTimer: NodeJS.Timeout | null = null;
  private improvementTimer: NodeJS.Timeout | null = null;
  private eaReviewTimer: NodeJS.Timeout | null = null;
  private outboundNotifierTimer: NodeJS.Timeout | null = null;
  private dashboardHealerTimer: NodeJS.Timeout | null = null;
  private modelHealthRenewalTimer: NodeJS.Timeout | null = null;
  private outboundNotifier: OutboundNotifier | null = null;
  private dashboardHealerState: DashboardHealerState = {
    lastRecoveryAt: null,
    recovering: false,
  };
  private supervisorWakeReconciliationState: SupervisorWakeReconciliationState =
    createSupervisorWakeReconciliationState();
  /** Serialise EA-review work — claude-code spawns are expensive; one at a time per dispatcher. */
  private eaReviewBusy = false;
  /** Serialise scheduled provider discovery inside this dispatcher process. */
  private modelDiscoveryBusy = false;
  /**
   * Set true by the bundle watcher when dispatcher-bundle.js changes on
   * disk. Once set, the dispatcher stops claiming new tasks, waits for
   * in-flight work to drain, then triggers a deferred restart so systemd
   * brings it back with the new code. This makes "rebuild = deploy"
   * autonomous — no human / EA needs to remember to restart after a
   * code change.
   */
  private drainRequested = false;
  /** Set true once attemptDrainExit has scheduled the deferred restart, to make it idempotent. */
  private restartScheduled = false;
  private bundleWatcher: BundleWatcherHandle | null = null;
  private pgvectorEnabled = false;
  private shutdownCallbacks: (() => Promise<void>)[] = [];
  private dynamicConcurrencyCap: number | null = null;

  constructor(config: DispatcherConfig = DEFAULT_CONFIG) {
    this.sql = postgres(DATABASE_URL);
    this.config = config;
    this.outboundNotifier = new OutboundNotifier(this.sql);
  }

  async start() {
    console.log("[dispatcher] Starting HiveWright dispatcher...");

    try {
      await assertDispatcherSchemaVersion(this.sql);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      await this.sql.end();
      throw err;
    }

    // 0. Ensure NOTIFY trigger exists
    await this.sql`
      CREATE OR REPLACE FUNCTION notify_new_task() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify('new_task', NEW.id::text);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
    await this.sql`
      DROP TRIGGER IF EXISTS task_insert_notify ON tasks
    `;
    await this.sql`
      CREATE TRIGGER task_insert_notify
        AFTER INSERT ON tasks
        FOR EACH ROW
        EXECUTE FUNCTION notify_new_task()
    `;
    // Same pattern for goal_comments so the supervisor wakes up on owner input
    // without waiting for a sprint to complete. Idempotent create — reruns are
    // safe across dispatcher restarts.
    await this.sql`
      CREATE OR REPLACE FUNCTION notify_new_goal_comment() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify('new_goal_comment', NEW.id::text);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
    await this.sql`DROP TRIGGER IF EXISTS goal_comment_insert_notify ON goal_comments`;
    await this.sql`
      CREATE TRIGGER goal_comment_insert_notify
        AFTER INSERT ON goal_comments
        FOR EACH ROW
        EXECUTE FUNCTION notify_new_goal_comment()
    `;
    await this.sql`
      CREATE OR REPLACE FUNCTION notify_new_decision_message() RETURNS trigger AS $$
      BEGIN
        PERFORM pg_notify('new_decision_message', NEW.id::text);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
    await this.sql`DROP TRIGGER IF EXISTS decision_message_insert_notify ON decision_messages`;
    await this.sql`
      CREATE TRIGGER decision_message_insert_notify
        AFTER INSERT ON decision_messages
        FOR EACH ROW
        EXECUTE FUNCTION notify_new_decision_message()
    `;
    console.log("[dispatcher] NOTIFY triggers ensured.");

    // 0b. Ensure critical indexes exist
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks (status, priority)`);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_tasks_hive_id ON tasks (hive_id)`);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_tasks_goal_id ON tasks (goal_id)`);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_role_memory_lookup ON role_memory (role_slug, hive_id) WHERE superseded_by IS NULL`);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_hive_memory_lookup ON hive_memory (hive_id) WHERE superseded_by IS NULL`);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_insights_hive ON insights (hive_id, status)`);
    await this.sql.unsafe(`CREATE INDEX IF NOT EXISTS idx_work_products_hive ON work_products (hive_id, synthesized)`);
    console.log("[dispatcher] Database indexes ensured.");

    // 1. Sync role library
    const roleLibraryPath = path.resolve(process.cwd(), "role-library");
    // HW_FORCE_ROLE_SYNC=1 makes startup reset recommended_model/adapter_type
    // from role.yaml — used to clear dashboard-configured drift.
    const resetModelAndAdapter = process.env.HW_FORCE_ROLE_SYNC === "1";
    await syncRoleLibrary(roleLibraryPath, this.sql, { resetModelAndAdapter });
    console.log(
      `[dispatcher] Role library synced${resetModelAndAdapter ? " (reset model+adapter from YAML)" : ""}.`,
    );

    // 2. Start file watcher for hot reload
    this.roleWatcher = watchRoleLibrary(roleLibraryPath, this.sql);
    console.log("[dispatcher] Role library watcher started.");

    // 2a. Watch the dispatcher bundle for changes — when a fresh
    // `npm run build:dispatcher` lands, drain in-flight work and
    // trigger a deferred restart so the new code goes live without
    // requiring a human or EA to remember to run systemctl restart.
    // The drain + deferred restart pattern makes the system robust
    // to the same kind of forced restart caused by a power outage,
    // OS reboot, or systemd cycle, so this is purely leveraging
    // robustness we already need to have.
    const bundlePath = path.resolve(process.cwd(), "dispatcher-bundle.js");
    this.bundleWatcher = watchBundleForRestart({
      bundlePath,
      onStale: () => {
        if (this.drainRequested) return;
        this.drainRequested = true;
        console.log("[dispatcher] Drain requested by bundle watcher — will stop claiming new tasks and exit when in-flight work completes.");
        void this.attemptDrainExit();
      },
    });

    // 2b. Sweep stale goal-supervisor entries from ~/.openclaw/ (removes entries
    // for goals that have already hit achieved/cancelled). Runs once per
    // dispatcher startup — self-healing catch for lifecycle-hook misses and
    // DB-direct cancellations.
    const sweep = await pruneStaleGoalSupervisors(this.sql);
    console.log(`[dispatcher] openclaw sweep: pruned=${sweep.pruned} kept=${sweep.kept} orphans=${sweep.orphansRemoved} errors=${sweep.errors.length}`);

    // 3. Set up LISTEN/NOTIFY
    this.taskListener = await createTaskListener(this.sql, (taskId) => {
      console.log(`[dispatcher] New task notification: ${taskId}`);
      this.processNextTask();
    });
    console.log("[dispatcher] Listening for new_task notifications.");

    // 3b. Listen for new goals — start supervisor immediately without waiting for timer
    const goalSubscription = await this.sql.listen("new_goal", (goalId) => {
      console.log(`[dispatcher] New goal notification: ${goalId} — starting supervisor immediately.`);
      this.runGoalLifecycleCheck().catch(err => console.error("[dispatcher] Goal lifecycle check error on goal notify:", err));
    });
    this.shutdownCallbacks.push(() => goalSubscription.unlisten());
    console.log("[dispatcher] Listening for new_goal notifications.");

    // 3c. Listen for new goal_comments — wake the goal supervisor so owner
    // comments trigger a re-plan / reply / complete action without waiting
    // for the 15-min sprint check. Owner-authored comments only; comments
    // created by the supervisor itself are skipped to prevent self-wake loops.
    const commentSubscription = await this.sql.listen("new_goal_comment", (commentId) => {
      console.log(`[dispatcher] New goal-comment notification: ${commentId}`);
      this.handleNewGoalComment(commentId).catch((err) =>
        console.error("[dispatcher] goal-comment handler error:", err),
      );
    });
    this.shutdownCallbacks.push(() => commentSubscription.unlisten());
    console.log("[dispatcher] Listening for new_goal_comment notifications.");

    const decisionMessageSubscription = await this.sql.listen("new_decision_message", (messageId) => {
      console.log(`[dispatcher] New decision-message notification: ${messageId}`);
      this.handleNewDecisionMessage(messageId).catch((err) =>
        console.error("[dispatcher] decision-message handler error:", err),
      );
    });
    this.shutdownCallbacks.push(() => decisionMessageSubscription.unlisten());
    console.log("[dispatcher] Listening for new_decision_message notifications.");

    // 4. Start poll fallback
    this.pollTimer = setInterval(() => {
      if (!this.shuttingDown) this.processNextTask();
    }, this.config.pollIntervalMs);
    console.log(`[dispatcher] Poll fallback every ${this.config.pollIntervalMs / 1000}s.`);

    // 5. Startup lifecycle recovery must run before the watchdog. If the
    // previous dispatcher died mid-task, those active rows belong back in the
    // pending queue; treating them as heartbeat timeouts would incorrectly
    // charge the agent and route avoidable work to doctor.
    try {
      const recovered = await recoverInterruptedActiveTasks(this.sql, process.pid);
      if (recovered.length > 0) {
        console.log(
          `[dispatcher] Startup recovery: requeued ${recovered.length} active task(s) from dead dispatcher PID(s).`,
        );
        for (const task of recovered) {
          console.log(
            `[dispatcher]   - task ${task.id} (${task.title}) from PID ${task.dispatcherPid}`,
          );
        }
      } else {
        console.log("[dispatcher] Startup recovery: no interrupted active tasks found.");
      }
    } catch (err) {
      console.error("[dispatcher] Startup active-task recovery error:", err);
    }

    // 5b. Start watchdog
    this.watchdogTimer = setInterval(() => {
      if (!this.shuttingDown) this.runWatchdog();
    }, this.config.watchdogIntervalMs);
    console.log(`[dispatcher] Watchdog every ${this.config.watchdogIntervalMs / 1000}s.`);

    // 6. Start schedule timer
    this.scheduleTimer = setInterval(() => {
      if (!this.shuttingDown) this.runScheduleCheck();
    }, this.config.scheduleIntervalMs);
    console.log(`[dispatcher] Schedule timer every ${this.config.scheduleIntervalMs / 1000}s.`);

    // 6a. Start adapter model discovery. The helper handles per-adapter
    // cadence (cloud daily, Ollama six-hourly), so an hourly dispatcher tick is
    // enough to keep discovery fresh without adding config surface.
    this.modelDiscoveryTimer = setInterval(() => {
      if (!this.shuttingDown) this.runModelDiscoveryCheck();
    }, MODEL_DISCOVERY_INTERVAL_MS);
    console.log(`[dispatcher] Model discovery every ${MODEL_DISCOVERY_INTERVAL_MS / 1000}s.`);
    void this.runModelDiscoveryCheck();

    this.modelHealthRenewalTimer = setInterval(() => {
      if (!this.shuttingDown) this.runModelHealthRenewalCheck();
    }, this.config.modelHealthRenewalIntervalMs);
    console.log(
      `[dispatcher] Model health renewal every ${this.config.modelHealthRenewalIntervalMs / 1000}s.`,
    );
    void this.runModelHealthRenewalCheck();

    // 7. Start sprint check timer
    this.sprintCheckTimer = setInterval(() => {
      if (!this.shuttingDown) {
        this.runGoalLifecycleCheck();
      }
    }, this.config.sprintCheckIntervalMs);
    console.log(`[dispatcher] Sprint check every ${this.config.sprintCheckIntervalMs / 1000}s.`);
    void this.runGoalLifecycleCheck();

    // 7a. Periodic recovery for dropped sprint-completion wake edges. The
    // normal lifecycle check is edge-driven by last_woken_sprint < sprint; this
    // pass handles the already-marked-but-not-progressed shape after restarts.
    this.supervisorWakeReconciliationTimer = setInterval(() => {
      if (!this.shuttingDown) {
        this.runSupervisorWakeReconciliationCheck();
      }
    }, this.config.supervisorWakeReconciliationIntervalMs);
    console.log(
      `[dispatcher] Supervisor wake reconciliation every ${this.config.supervisorWakeReconciliationIntervalMs / 1000}s.`,
    );
    void this.runSupervisorWakeReconciliationCheck();

    // 7b. Boot recovery: rescue goals stranded by a mid-wake crash. The
    // markSprintWakeUpSent / wakeUpSupervisor pattern bumps last_woken_sprint
    // before the (5-min, blocking) wake call. If the dispatcher is killed
    // during that window, the goal is left looking "already woken" forever.
    // revertSprintWakeUp now handles the in-process failure path; this sweep
    // catches the cross-process case where we never got to the finally block.
    try {
      const orphans = await findOrphanedWakeUps(this.sql);
      if (orphans.length > 0) {
        console.log(
          `[dispatcher] Boot recovery: found ${orphans.length} orphaned wake-up(s); resetting last_woken_sprint so the next sprint check re-wakes.`,
        );
        for (const o of orphans) {
          console.log(
            `[dispatcher]   - goal ${o.goalId} sprint ${o.sprintNumber} (last touched ${o.updatedAt.toISOString()})`,
          );
          await revertSprintWakeUp(this.sql, o.goalId, o.sprintNumber);
        }
      } else {
        console.log("[dispatcher] Boot recovery: no orphaned wake-ups found.");
      }
    } catch (err) {
      console.error("[dispatcher] Boot recovery error:", err);
    }

    // 7c. Initialize embeddings (pgvector)
    this.pgvectorEnabled = await checkPgvectorAvailable(this.sql);
    if (this.pgvectorEnabled) {
      await initializeEmbeddings(this.sql);
      console.log("[dispatcher] pgvector enabled, embeddings initialized.");
    } else {
      console.log("[dispatcher] pgvector not available, using recency-based memory only.");
    }

    // 7d. Start synthesis timer + run once on boot so the curator picks up
    // any insights that accumulated while the dispatcher was down (otherwise
    // we'd wait a full synthesisIntervalMs — currently 2h — before the inbox
    // moves).
    this.synthesisTimer = setInterval(() => {
      if (!this.shuttingDown) this.runSynthesisCheck();
    }, this.config.synthesisIntervalMs);
    console.log(`[dispatcher] Synthesis timer every ${this.config.synthesisIntervalMs / 1000}s.`);
    if (!this.shuttingDown) {
      this.runSynthesisCheck().catch((err) =>
        console.error("[dispatcher] Boot synthesis check error:", err),
      );
    }

    // 7e. Start credential expiry check (every hour)
    this.credentialCheckTimer = setInterval(() => {
      if (!this.shuttingDown) this.checkCredentialExpiry();
    }, 3_600_000);
    console.log("[dispatcher] Credential expiry check every 3600s.");

    // 7f. Start decision escalation check (every 15 minutes)
    this.escalationTimer = setInterval(() => {
      if (!this.shuttingDown) this.checkDecisionEscalation();
    }, 900_000);
    console.log("[dispatcher] Decision escalation check every 900s.");

    // 7f2. EA-first decision pipeline. Every system-generated decision
    // is created with status='ea_review' and waits here until a
    // headless EA agent decides whether to auto-resolve it or escalate
    // to the owner with plain-English context. See feedback memory
    // "Decisions go to EA first" for the policy.
    const eaReviewSubscription = await this.sql.listen("new_ea_review_decision", (decisionId) => {
      console.log(`[dispatcher] New ea_review decision: ${decisionId}`);
      this.runEaReviewPass().catch((err) =>
        console.error("[dispatcher] EA review pass error on notify:", err),
      );
    });
    this.shutdownCallbacks.push(() => eaReviewSubscription.unlisten());
    this.eaReviewTimer = setInterval(() => {
      if (!this.shuttingDown) this.runEaReviewPass();
    }, 60_000);
    console.log("[dispatcher] EA decision-review timer every 60s.");
    void this.runEaReviewPass();

    // 7f4. Owner wake-up notifier. Tight allowlist only: owner-tier
    // decisions, achieved goals, and failed/abandoned goals.
    this.outboundNotifierTimer = setInterval(() => {
      if (!this.shuttingDown) this.runOutboundNotifierScan();
    }, 30_000);
    console.log("[dispatcher] Outbound notifier scan every 30s.");
    void this.runOutboundNotifierScan();

    // 7f3. Dashboard cache healer. Next dev occasionally serves 404 for most
    // routes when its .next cache corrupts; only clear the cache after a
    // multi-route 404 signal, never on normal restarts.
    this.dashboardHealerTimer = setInterval(() => {
      if (!this.shuttingDown) this.runDashboardHealerCheck();
    }, 60_000);
    console.log("[dispatcher] Dashboard healer every 60s.");
    void this.runDashboardHealerCheck();

    // 7g. Start improvement sweeper (weekly). Also runs once at boot so a
    // fresh deploy immediately produces proposals for the owner to see.
    this.improvementTimer = setInterval(() => {
      if (!this.shuttingDown) this.runImprovementSweep();
    }, 7 * 24 * 3_600_000); // 7 days
    console.log("[dispatcher] Improvement sweep timer every 7d.");
    void this.runImprovementSweep();

    // 7h. Seed default schedules (daily world-scan) for any hive that's
    // missing it. Idempotent — existing installs keep their schedules.
    void this.seedDefaultSchedulesForAllHives();

    // 8. Start a native Discord EA per active `ea-discord` connector
    // install. Zero installs = no-op (OpenClaw-backed EA keeps running
    // in parallel if its gateway is up). Config lives on
    // connector_installs + credentials — owner installs/edits it via
    // the standard /setup/connectors dashboard page.
    try {
      const { maybeStartNativeEa } = await import("../ea/native");
      const eaHandles = await maybeStartNativeEa(this.sql);
      for (const handle of eaHandles) {
        this.shutdownCallbacks.push(() => handle.shutdown());
      }
      if (eaHandles.length > 0) {
        console.log(`[dispatcher] Native EA started ${eaHandles.length} install(s).`);
      }
    } catch (err) {
      console.error("[dispatcher] native EA connector failed to start:", err);
    }

    // 9. Voice WS server — terminates Twilio Media Streams for inbound
    // calls from the PWA's Voice SDK. One connection per call. See
    // src/dispatcher/voice-ws-server.ts.
    try {
      const { startVoiceWsServer } = await import("./voice-ws-server");
      const port = parseInt(process.env.VOICE_WS_PORT ?? "8791", 10);
      const handle = startVoiceWsServer(this.sql, port);
      this.shutdownCallbacks.push(() => handle.shutdown());
      console.log(`[dispatcher] Voice WS server listening on port ${port}.`);
    } catch (err) {
      console.error("[dispatcher] voice WS server failed to start:", err);
    }

    // 10. Register shutdown handlers
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());

    console.log("[dispatcher] Dispatcher ready.");

    // Do an initial task sweep
    await this.processNextTask();
  }

  private claimingTask = false;

  private async processNextTask() {
    if (this.shuttingDown) return;
    // While drain is requested (bundle changed on disk) we must NOT
    // start any new work — the goal is to let in-flight tasks finish
    // and then exit cleanly so systemd brings the new bundle online.
    if (this.drainRequested) return;
    if (this.claimingTask) return;

    // Live cap: read maxConcurrentTasks from adapter_config every claim
    // cycle so the dashboard's edit takes effect without a dispatcher
    // restart. Falls back to the bundled default if the row is missing.
    // The query is one indexed lookup — cheap enough to run per-cycle.
    const liveMaxConcurrent = await this.getLiveMaxConcurrent();

    this.claimingTask = true;
    try {
      while (!this.shuttingDown && !this.drainRequested && this.activeTasks < liveMaxConcurrent) {
        const task = await claimNextTask(this.sql, process.pid);
        if (!task) break;

        this.activeTasks++;
        console.log(`[dispatcher] Claimed task: ${task.id} (${task.title}) -> ${task.assignedTo} [${this.activeTasks}/${liveMaxConcurrent} active]`);

        void this.executeTask(task).finally(() => {
          this.activeTasks = Math.max(0, this.activeTasks - 1);
          void this.processNextTask();
        });
      }
    } catch (err) {
      console.error("[dispatcher] Error claiming task:", err);
    } finally {
      this.claimingTask = false;
    }
  }

  private async executeTask(task: ClaimedTask) {
    try {
      try {
        await emitTaskEvent(this.sql, { type: "task_claimed", taskId: task.id, title: task.title, assignedTo: task.assignedTo, hiveId: task.hiveId });
      } catch { /* ignore event emission errors */ }

      // 1. Build session context
      const ctx = await buildSessionContext(this.sql, task);
      const workspaceProvision = await provisionTaskWorkspace(this.sql, ctx);
      if (workspaceProvision.status === "failed") {
        const reason = `Worktree provisioning failed: ${workspaceProvision.reason || "unknown error"}`;
        console.error(`[dispatcher] ${reason}`);
        await writeTaskLog(this.sql, {
          taskId: task.id,
          goalId: task.goalId ?? undefined,
          chunk: reason,
          type: "status",
        }).catch(() => {});
        await handleTaskFailureAndDoctor(
          this.sql, task.id, FailureCategory.SpawnFailure,
          reason, this.config
        );
        return;
      }
      if (workspaceProvision.status === "skipped") {
        console.log(`[dispatcher] Worktree isolation skipped for ${task.id}: ${workspaceProvision.reason}`);
      } else {
        console.log(`[dispatcher] Worktree isolation active for ${task.id}: ${workspaceProvision.worktreePath}`);
      }

      // 2. Pre-flight checks
      const preflight = await runPreFlightChecks(ctx);
      if (!preflight.passed) {
        console.log(`[dispatcher] Pre-flight failed for ${task.id}: ${preflight.failures.join(", ")}`);
        await handleTaskFailureAndDoctor(
          this.sql, task.id, FailureCategory.SpawnFailure,
          `Pre-flight failed: ${preflight.failures.join("; ")}`, this.config
        );
        return;
      }

      // 3. Pre-task QA (brief validation)
      const [roleRow] = await this.sql`SELECT type FROM role_templates WHERE slug = ${task.assignedTo}`;
      const briefCheck = validateBrief({
        title: task.title,
        brief: task.brief,
        acceptanceCriteria: task.acceptanceCriteria,
        assignedTo: task.assignedTo,
        roleType: roleRow?.type ?? "executor",
      });
      if (briefCheck.warnings.length > 0) {
        console.log(`[dispatcher] Brief warnings for ${task.id}: ${briefCheck.warnings.join(", ")}`);
      }

      // 4. Resolve adapter + cross-adapter fallback. If the primary adapter's
      // provisioner is unhealthy (e.g. local Ollama endpoint offline), swap
      // to the fallback adapter+model so the task actually runs instead of
      // dying on spawn. fallback_adapter_type = NULL keeps the historical
      // same-adapter behaviour.
      const primaryAdapterType = (ctx.primaryAdapterType as string) || "claude-code";
      let adapterType = primaryAdapterType;
      let adapter = await this.resolveAdapter(adapterType);

      const primaryHealthy = await this.isAdapterHealthy(adapterType, task.assignedTo, ctx.model, task.hiveId);
      let fallbackHealthy: boolean | undefined;
      if (!primaryHealthy && ctx.fallbackAdapterType && ctx.fallbackModel) {
        fallbackHealthy = await this.isAdapterHealthy(
          ctx.fallbackAdapterType,
          task.assignedTo,
          ctx.fallbackModel,
          task.hiveId,
        );
      }

      const route = decideProviderFailoverRoute({
        primaryAdapterType,
        primaryModel: ctx.model,
        fallbackAdapterType: ctx.fallbackAdapterType,
        fallbackModel: ctx.fallbackModel,
        primaryHealthy,
        fallbackHealthy,
      });
      if (route.usedFallback) {
        console.log(
          `[dispatcher] Primary adapter ${primaryAdapterType} unhealthy — switching task ${task.id} to fallback ${route.adapterType}/${route.model}`,
        );
        adapterType = route.adapterType;
        adapter = await this.resolveAdapter(adapterType);
        ctx.model = route.model;
        // Null the fallback to prevent the adapter from trying to fall back again to itself.
        if (route.clearFallbackModel) ctx.fallbackModel = null;
      }

      if (!route.canRun) {
        const reason = [
          "runtime_blocked: Runtime health gate blocked task before spawn.",
          `Resolved route: ${route.adapterType}/${route.model}.`,
          `Reason: ${route.reason}.`,
        ].join(" ");
        console.warn(`[dispatcher] ${reason} task=${task.id}`);
        await writeTaskLog(this.sql, {
          taskId: task.id,
          goalId: task.goalId ?? undefined,
          chunk: reason,
          type: "status",
        }).catch(() => {});
        await blockTask(this.sql, task.id, reason);
        return;
      }

      // 5. Execute with heartbeat + real-time chunk streaming
      // Persist the resolved model on the task row so live dashboards can show
      // which LLM is actually running. The adapter may report a more specific
      // value (e.g. a dated sub-version) via result.modelUsed — that overwrites
      // this one at completion in step 6.
      try {
        await this.sql`UPDATE tasks SET model_used = ${ctx.model}, adapter_used = ${adapterType} WHERE id = ${task.id}`;
      } catch { /* best-effort — don't block execution on a metadata write */ }

      console.log(`[dispatcher] Executing task ${task.id} via ${adapterType} adapter...`);
      const heartbeatTimer = setInterval(async () => {
        try {
          await this.sql`UPDATE tasks SET last_heartbeat = NOW() WHERE id = ${task.id}`;
        } catch { /* ignore heartbeat errors */ }
      }, 30_000);

      // goalId is threaded into every writeTaskLog call so the goal-level SSE
      // stream (GET /api/goals/:id/stream) receives all chunks for this task.
      const goalId = task.goalId ?? undefined;

      // Write a "status" start chunk so SSE clients see something immediately.
      try {
        await writeTaskLog(this.sql, {
          taskId: task.id,
          goalId,
          chunk: `Starting task: ${task.title}`,
          type: "status",
        });
        if (adapterType !== "codex") {
          await writeTaskContextProvenanceLog(this.sql, {
            taskId: task.id,
            goalId,
            provenance: buildSessionContextProvenance(ctx),
          });
        }
      } catch { /* ignore — streaming is best-effort */ }

      // Callback provided to the adapter: each stdout/stderr buffer triggers a
      // DB write + pg_notify so live SSE clients receive it within milliseconds.
      // We also bump last_heartbeat on every chunk so adapters that produce
      // bursty output (codex, openclaw) keep the watchdog confident even if
      // the 30s timer happens to land in a quiet window.
      let lastHeartbeatBumpAt = 0;
      let streamedStdout = "";
      let streamedStderr = "";
      const onChunk = async (c: { text: string; type: "stdout" | "stderr" | "status" | "diagnostic" | "done" }) => {
        try {
          if (c.type === "stdout") streamedStdout = appendBoundedRuntimeContext(streamedStdout, c.text);
          if (c.type === "stderr") streamedStderr = appendBoundedRuntimeContext(streamedStderr, c.text);
          await writeTaskLog(this.sql, { taskId: task.id, goalId, chunk: c.text, type: c.type });
          // Throttle to once per 10s — chunks can arrive at hundreds-per-second
          // and we don't need a heartbeat update on every byte.
          const now = Date.now();
          if (now - lastHeartbeatBumpAt > 10_000) {
            lastHeartbeatBumpAt = now;
            this.sql`UPDATE tasks SET last_heartbeat = NOW() WHERE id = ${task.id}`.catch(() => {});
          }
        } catch { /* ignore — streaming is best-effort */ }
      };

      const supportsPersistentSessions = adapterSupports(adapterType, "persistentSessions");
      const sendPersistentMessage = supportsPersistentSessions && adapter.sendMessage
        ? adapter.sendMessage.bind(adapter)
        : null;
      const reusableCapsule = sendPersistentMessage
        ? await findReusableExecutionCapsule(this.sql, { taskId: task.id, adapterType })
        : null;

      let result;
      try {
        if (reusableCapsule?.status === "qa_failed" && sendPersistentMessage) {
          const reworkPrompt = buildQaReworkPrompt({
            title: task.title,
            brief: task.brief,
            acceptanceCriteria: task.acceptanceCriteria,
            feedback: reusableCapsule.lastQaFeedback,
          });
          result = await sendPersistentMessage(reusableCapsule.sessionId, reworkPrompt, ctx, onChunk);
        } else {
          result = await adapter.execute(ctx, onChunk);
        }
      } finally {
        clearInterval(heartbeatTimer);
      }

      if (result.success && (supportsPersistentSessions || result.sessionId)) {
        await upsertExecutionCapsule(this.sql, {
          taskId: task.id,
          hiveId: task.hiveId,
          adapterType,
          model: result.modelUsed || ctx.model,
          sessionId: result.sessionId ?? reusableCapsule?.sessionId ?? null,
          lastOutput: result.output,
        });
      }

      if (result.runtimeWarnings?.length) {
        for (const warning of result.runtimeWarnings.filter(Boolean)) {
          try {
            await writeTaskLog(this.sql, {
              taskId: task.id,
              goalId,
              chunk: `[runtime-warning] ${warning}`,
              type: "status",
            });
          } catch { /* ignore */ }
        }
      }

      if (result.runtimeDiagnostics?.codexEmptyOutput) {
        try {
          await writeTaskLog(this.sql, {
            taskId: task.id,
            goalId,
            chunk: JSON.stringify(result.runtimeDiagnostics.codexEmptyOutput),
            type: "diagnostic",
          });
        } catch { /* ignore */ }
      } else if (adapterType === "codex") {
        const streamedAgentOutput = collectCodexAgentTexts(streamedStdout);
        const hasAgentOutput = streamedAgentOutput.trim().length > 0 || (result.success && result.output.trim().length > 0);
        const stderrSignaturePresent = isCodexRolloutRegistrationFailure(streamedStderr);
        if (!hasAgentOutput && stderrSignaturePresent) {
          const diagnostic = buildCodexEmptyOutputDiagnostic({
            rawStdout: streamedStdout,
            stderr: streamedStderr,
            exitCode: parseExitCode(result.failureReason),
            effectiveAdapter: adapterType,
            adapterOverride: task.adapterOverride ?? null,
            modelSlug: ctx.model,
            modelProviderMismatchDetected: detectCodexModelProviderMismatch(adapterType, ctx.model),
            cwd: ctx.workspaceIsolation?.status === "active" && ctx.workspaceIsolation.worktreePath
              ? ctx.workspaceIsolation.worktreePath
              : ctx.projectWorkspace ?? process.cwd(),
            taskWorkspace: ctx.projectWorkspace,
            rolloutSignaturePresent: true,
          });
          result.runtimeDiagnostics = { ...(result.runtimeDiagnostics ?? {}), codexEmptyOutput: diagnostic };
          try {
            await writeTaskLog(this.sql, {
              taskId: task.id,
              goalId,
              chunk: JSON.stringify(diagnostic),
              type: "diagnostic",
            });
          } catch { /* ignore */ }
        }
      }

      if (adapterType === "codex") {
        try {
          await writeTaskContextProvenanceLog(this.sql, {
            taskId: task.id,
            goalId,
            provenance: buildSessionContextProvenance(ctx),
          });
        } catch { /* ignore */ }
      }

      // Write terminal "done" chunk. Because execute() awaits all pending onChunk
      // promises before resolving, this is always the last row in task_logs for
      // this task, which is what the SSE endpoint relies on to close the stream.
      try {
        await writeTaskLog(this.sql, { taskId: task.id, goalId, chunk: "", type: "done" });
      } catch { /* ignore */ }

      // 6. Record cost
      if (
        result.tokensInput ||
        result.tokensOutput ||
        result.cachedInputTokens !== undefined ||
        result.cacheCreationTokens !== undefined ||
        result.costCents !== undefined ||
        result.estimatedBillableCostCents !== undefined
      ) {
        await recordTaskCost(this.sql, task.id, {
          tokensInput: result.tokensInput ?? 0,
          totalContextTokens: result.totalContextTokens,
          freshInputTokens: result.freshInputTokens,
          cachedInputTokens: result.cachedInputTokens,
          cacheCreationTokens: result.cacheCreationTokens,
          cachedInputTokensKnown: result.cachedInputTokensKnown,
          tokensOutput: result.tokensOutput ?? 0,
          costCents: result.costCents,
          estimatedBillableCostCents: result.estimatedBillableCostCents,
          modelUsed: result.modelUsed || ctx.model,
          adapterUsed: adapterType,
          usageDetails: result.usageDetails,
        });

        // Check goal budget
        if (task.goalId) {
          const budget = await checkGoalBudget(this.sql, task.goalId);
          if (budget.exceeded) {
            console.log(`[dispatcher] Goal ${task.goalId} budget exceeded: ${budget.spentCents}/${budget.budgetCents} cents`);
          }
        }

        const aiBudget = await checkAiBudget(this.sql, task.hiveId);
        if (aiBudget.state === "breached" && aiBudget.enforcement.blocksNewWork) {
          console.log(`[dispatcher] Hive ${task.hiveId} AI spend budget breached: ${aiBudget.consumedCents}/${aiBudget.capCents} cents`);
        }
      }

      // 7. Handle failure
      if (!result.success) {
        console.log(`[dispatcher] Task ${task.id} failed: ${result.failureReason}`);
        const failureCategory = result.failureKind === "execution_slice_exceeded"
          ? FailureCategory.ExecutionSliceExceeded
          : FailureCategory.AgentReported;
        await handleTaskFailureAndDoctor(
          this.sql, task.id, failureCategory,
          result.failureReason || "Unknown failure", this.config
        );
        try {
          await emitTaskEvent(this.sql, { type: "task_failed", taskId: task.id, title: task.title, assignedTo: task.assignedTo, hiveId: task.hiveId });
        } catch { /* ignore event emission errors */ }
        return;
      }

      // 8. Emit work product + extract facts
      if (shouldEmitWorkProduct(task.title)) {
        const wp = await emitWorkProduct(this.sql, {
          taskId: task.id,
          hiveId: task.hiveId,
          roleSlug: task.assignedTo,
          department: ctx.roleTemplate.department,
          content: result.output,
          summary: result.output,
          usageDetails: result.usageDetails ?? null,
        });

        if (result.artifacts?.length) {
          for (const artifact of result.artifacts) {
            if (artifact.kind !== "image") continue;
            await emitBinaryWorkProduct(this.sql, {
              taskId: task.id,
              hiveId: task.hiveId,
              roleSlug: task.assignedTo,
              department: ctx.roleTemplate.department,
              content: result.output,
              summary: result.output,
              artifactKind: "image",
              filePath: artifact.path,
              mimeType: artifact.mimeType,
              width: artifact.width,
              height: artifact.height,
              modelName: artifact.modelName,
              modelSnapshot: artifact.modelSnapshot,
              promptTokens: artifact.promptTokens ?? result.tokensInput ?? null,
              outputTokens: artifact.outputTokens ?? result.tokensOutput ?? null,
              costCents: artifact.costCents ?? calculateCostCents(
                artifact.modelSnapshot,
                artifact.promptTokens ?? result.tokensInput ?? 0,
                artifact.outputTokens ?? result.tokensOutput ?? 0,
              ),
              usageDetails: artifact.usageDetails ?? result.usageDetails ?? null,
              metadata: artifact.metadata ?? null,
            });
          }
        }

        // 8b. Extract facts from work product
        try {
          const existingRole = await this.sql`
            SELECT id, content, confidence FROM role_memory
            WHERE role_slug = ${task.assignedTo} AND hive_id = ${task.hiveId}
              AND superseded_by IS NULL
            ORDER BY updated_at DESC LIMIT 20
          `;
          const existingBiz = await this.sql`
            SELECT id, content, confidence, category FROM hive_memory
            WHERE hive_id = ${task.hiveId} AND superseded_by IS NULL
            ORDER BY updated_at DESC LIMIT 20
          `;

          const extractionCtx: ExtractionContext = {
            workProductContent: result.output,
            roleSlug: task.assignedTo,
            hiveId: task.hiveId,
            department: ctx.roleTemplate.department,
            taskId: task.id,
            existingRoleMemories: existingRole.map((r) => ({
              id: r.id as string,
              content: r.content as string,
              confidence: r.confidence as number,
            })),
            existingHiveMemories: existingBiz.map((r) => ({
              id: r.id as string,
              content: r.content as string,
              confidence: r.confidence as number,
              category: r.category as string,
            })),
          };

          const extraction = await extractAndStore(this.sql, extractionCtx, getModelConfig());
          if (extraction.operationResults.length > 0) {
            console.log(`[dispatcher] Extracted ${extraction.operationResults.length} fact(s) from task ${task.id}`);
          }

          // Generate embedding for the work product
          if (this.pgvectorEnabled && wp?.id) {
            try {
              await storeEmbedding(this.sql, {
                sourceType: "work_product",
                sourceId: wp.id as string,
                hiveId: task.hiveId,
                text: result.output.slice(0, 2000),
                pgvectorEnabled: true,
              });
            } catch (embErr) {
              console.error("[dispatcher] Work product embedding error:", embErr);
            }
          }
        } catch (extractErr) {
          console.error("[dispatcher] Fact extraction error:", extractErr);
        }

        // Also extract entities for graph memory
        try {
          const { extractAndStoreEntities } = await import("../memory/entity-extractor");
          const entityResult = await extractAndStoreEntities(
            this.sql, task.hiveId, result.output, task.id, getModelConfig()
          );
          if (entityResult.entitiesStored > 0 || entityResult.relationshipsStored > 0) {
            console.log(`[dispatcher] Extracted ${entityResult.entitiesStored} entities, ${entityResult.relationshipsStored} relationships from task ${task.id}`);
          }
        } catch (entityErr) {
          console.error("[dispatcher] Entity extraction error:", entityErr);
        }

      }

      const runtimeWarnings = result.runtimeWarnings?.filter(Boolean) ?? [];
      const completionOptions = runtimeWarnings.length > 0 ? { runtimeWarnings } : undefined;
      const persistRuntimeWarnings = async () => {
        if (runtimeWarnings.length === 0) return;
        await this.sql`
          UPDATE tasks
          SET failure_reason = ${runtimeWarnings.join("\n")}, updated_at = NOW()
          WHERE id = ${task.id}
        `;
      };

      // 8b. Doctor task: parse the diagnosis and apply it to the parent task.
      //     STRATEGY:
      //     - If parse succeeds → apply the diagnosis (best outcome: structured self-healing).
      //     - If parse fails because there was no fenced JSON block → fall through
      //       to the existing pattern-matching shim below (status quo behaviour).
      //     - If parse fails for any OTHER reason (malformed JSON, unknown action,
      //       missing required fields) → escalate to Tier 3 decision. The doctor
      //       attempted structured output and got it wrong, which means human
      //       intervention is the safer next step than a blind retry.
      //
      //     `doctorHandled` controls whether the legacy shim below also runs —
      //     on successful parse OR explicit escalation, the shim is skipped.
      const doctorHandled = await applyStructuredDoctorDiagnosis(this.sql, task, result.output);
      if (task.assignedTo === "doctor" && task.parentTaskId) {
        // When doctorHandled is true, the entire if/else-if/else chain below
        // must be skipped — including the final `else` that would otherwise
        // run QUESTION_PATTERN detection on the doctor's diagnostic prose
        // and potentially flip the task to `blocked` or create a duplicate
        // decision. Close the doctor task here and emit its completion event.
        if (doctorHandled) {
          await completeTask(this.sql, task.id, result.output, completionOptions);
          console.log(`[dispatcher] Doctor task ${task.id} completed (structured diagnosis path).`);
          try {
            await emitTaskEvent(this.sql, {
              type: "task_completed",
              taskId: task.id,
              title: task.title,
              assignedTo: task.assignedTo,
              hiveId: task.hiveId,
            });
          } catch { /* ignore event emission errors */ }
        }
      }

      // 8c. Hive-supervisor task: finalize the deferred supervisor_reports row.
      //     The heartbeat's production path enqueues a hive-supervisor task and
      //     returns output="" so the schedule timer does not block on an agent
      //     turn — the supervisor_reports row is created up-front with NULL
      //     actions/action_outcomes. When the task completes here, this hook
      //     parses the agent's fenced-JSON block, applies the actions, and
      //     writes them back. Mirrors the doctor hook at 8b.
      //
      //     `supervisorHandled` joins `doctorHandled` in the block-9 guard so
      //     the supervisor's structured JSON never runs through QUESTION_PATTERN
      //     detection (which would flip the task to `blocked` and spawn a
      //     duplicate decision).
      let supervisorHandled = false;
      if (task.assignedTo === "hive-supervisor") {
        const { finalizeDeferredSupervisorReport } = await import("../supervisor");
        try {
          const finalized = await finalizeDeferredSupervisorReport(this.sql, {
            taskId: task.id,
            hiveId: task.hiveId,
            agentOutput: result.output,
          });
          console.log(
            `[dispatcher] Supervisor task ${task.id} finalized: ${finalized.status}` +
              (finalized.status === "applied"
                ? ` (applied=${finalized.actionsApplied}, skipped=${finalized.actionsSkipped}, errored=${finalized.actionsErrored})`
                : ""),
          );
          supervisorHandled = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[dispatcher] finalizeDeferredSupervisorReport failed for task ${task.id}: ${msg}`,
          );
          // Don't set supervisorHandled — fall through to normal completion so
          // the task still closes and the watchdog doesn't pin it as stuck.
          // The supervisor_reports row stays NULL; dashboard will show the
          // orphan row and the next heartbeat will create a fresh one.
        }
        if (supervisorHandled) {
          await completeTask(this.sql, task.id, result.output, completionOptions);
          try {
            await emitTaskEvent(this.sql, {
              type: "task_completed",
              taskId: task.id,
              title: task.title,
              assignedTo: task.assignedTo,
              hiveId: task.hiveId,
            });
          } catch { /* ignore event emission errors */ }
        }
      }

      // 9. Doctor task result processing — LEGACY auto-retry shim, runs only
      //    when the new parse+apply hook at 8b didn't handle this task (i.e.
      //    doctor produced no fenced JSON block). Kept as a safety net while
      //    the doctor role migrates to reliably emitting structured output.
      //    The outer `!doctorHandled` guard wraps the ENTIRE if/else-if/else
      //    chain below — when block 8b handled the task, no branch here runs.
      //    `supervisorHandled` joins the guard so block 8c's deferred-report
      //    writeback also skips the legacy QUESTION_PATTERN branch.
      if (!doctorHandled && !supervisorHandled) {
      if (task.parentTaskId && task.title.startsWith("[Doctor]")) {
        const FIXABLE_PATTERNS = ["spawn ENOENT", "ENOENT", "permission denied"];
        const EXECUTION_SLICE_PATTERNS = ["execution slice exceeded adapter timeout", "needs decomposition into smaller tasks", "checkpointed implementation"];
        const [parentTask] = await this.sql<{
          hive_id: string;
          goal_id: string | null;
          status: string;
          failure_reason: string | null;
          retry_count: number | null;
        }[]>`
          SELECT hive_id, goal_id, status, failure_reason, retry_count FROM tasks WHERE id = ${task.parentTaskId}
        `;
        const failureReason = ((parentTask?.failure_reason as string) || "").toLowerCase();
        const isFixable = FIXABLE_PATTERNS.some(p => failureReason.includes(p.toLowerCase()));
        const isExecutionSlice = EXECUTION_SLICE_PATTERNS.some(p => failureReason.includes(p.toLowerCase()));
        const retryCount = (parentTask?.retry_count as number) ?? 0;

        if (isExecutionSlice) {
          console.log(`[dispatcher] Doctor classified parent task ${task.parentTaskId} as execution-slice-limited; leaving failed for supervisor/owner rescoping instead of auto-retrying.`);
        } else if (isFixable && retryCount < 3) {
          const [updatedParentTask] = await this.sql<{ status: string }[]>`
            UPDATE tasks
            SET status = 'pending', retry_count = retry_count + 1,
                retry_after = NULL, updated_at = NOW()
            WHERE id = ${task.parentTaskId}
            RETURNING status
          `;
          await recordTaskLifecycleTransitionBestEffort(this.sql, {
            taskId: task.parentTaskId,
            hiveId: parentTask.hive_id,
            goalId: parentTask.goal_id,
            previousStatus: parentTask.status,
            nextStatus: updatedParentTask?.status ?? "pending",
            source: "dispatcher.doctorAutoRetry",
            reason: `Doctor auto-retry after fixable failure: ${parentTask.failure_reason ?? "unknown failure"}`,
          });
          console.log(`[dispatcher] Doctor auto-retry: reset task ${task.parentTaskId} to pending (attempt ${retryCount + 1}/3)`);
        } else if (isFixable) {
          console.log(`[dispatcher] Doctor auto-retry: task ${task.parentTaskId} hit retry cap (${retryCount}/3), leaving failed`);
        }

        await completeTask(this.sql, task.id, result.output, completionOptions);
        console.log(`[dispatcher] Doctor task ${task.id} completed.`);

      // QA verdict processing (if this IS a QA task)
      } else if (task.parentTaskId && task.title.startsWith("[QA]")) {
        const verdict = parseQaVerdict(result.output);
        const feedback = result.output.slice(0, 1000);

        if (verdict === "pass") {
          console.log(`[dispatcher] QA task ${task.id} verdict: PASS`);
          await processQaResult(this.sql, task.parentTaskId, { passed: true, feedback: null });
        } else if (verdict === "fail") {
          console.log(`[dispatcher] QA task ${task.id} verdict: FAIL`);
          await processQaResult(this.sql, task.parentTaskId, { passed: false, feedback });
        } else {
          // No explicit verdict on its own line — do not convert parser/runtime noise into quality rework.
          const lower = result.output.toLowerCase();
          const blockedPattern = /\bcould not\b|\bunable to\b|\bno (work product|deliverable|file|access)\b|\bpermission denied\b|\btool unavailable\b|\bruntime\b|\bspawn\b|\badapter\b|\bmodel\b|\bhealth gate\b/;
          const failureClass = blockedPattern.test(lower) ? "runtime_blocked" : "parser_unknown";
          const reason = `${failureClass}: QA review did not produce a reliable pass/fail verdict; not treating this as a quality failure. Feedback excerpt: ${feedback}`;
          console.log(`[dispatcher] QA task ${task.id} ${failureClass} — blocking parent ${task.parentTaskId} instead of triggering QA rework.`);
          await processQaResult(this.sql, task.parentTaskId, { passed: false, feedback: reason, failureClass });
        }
        await completeTask(this.sql, task.id, result.output, completionOptions);
        console.log(`[dispatcher] QA task ${task.id} completed.`);

      // 10. Regular QA routing or complete
      } else if (task.qaRequired) {
        await routeToQa(this.sql, task.id, result.output);
        await persistRuntimeWarnings();
        console.log(`[dispatcher] Task ${task.id} routed to QA.`);
        try {
          await emitTaskEvent(this.sql, { type: "task_completed", taskId: task.id, title: task.title, assignedTo: task.assignedTo, hiveId: task.hiveId });
        } catch { /* ignore event emission errors */ }
      } else {
        // Auto-detect question-like output and block the task pending owner input
        const QUESTION_PATTERN = /clarifying question|which approach|before I proceed|need.*clarification|awaiting.*decision/i;
        if (task.goalId && QUESTION_PATTERN.test(result.output)) {
          try {
            const decisionRes = await fetch("http://localhost:3002/api/decisions", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                hiveId: task.hiveId,
                taskId: task.id,
                question: result.output,
                context: task.title,
                options: [],
                goalId: task.goalId,
              }),
            });
            if (!decisionRes.ok) {
              console.error(`[dispatcher] Failed to create decision for task ${task.id}: ${decisionRes.status}`);
            } else {
              console.log(`[dispatcher] Auto-created decision for task ${task.id} (question detected in output).`);
            }
          } catch (decisionErr) {
            console.error("[dispatcher] Error auto-creating decision:", decisionErr);
          }
          await blockTask(this.sql, task.id);
          console.log(`[dispatcher] Task ${task.id} blocked — awaiting owner decision.`);
        } else {
          await completeTask(this.sql, task.id, result.output, completionOptions);
          await markCapsuleCompleted(this.sql, task.id);
          console.log(`[dispatcher] Task ${task.id} completed.`);
          try {
            await emitTaskEvent(this.sql, { type: "task_completed", taskId: task.id, title: task.title, assignedTo: task.assignedTo, hiveId: task.hiveId });
          } catch { /* ignore event emission errors */ }
        }
      }
      } // end of !doctorHandled guard on block 9/10

      // 11. Immediate sprint-complete check — don't wait for the 15-min timer
      if (task.goalId && task.sprintNumber) {
        try {
          const completedSprints = await findCompletedSprintsForWakeUp(this.sql);
          const thisSprint = completedSprints.find(
            s => s.goalId === task.goalId && s.sprintNumber === task.sprintNumber
          );
          if (thisSprint) {
            console.log(`[dispatcher] Sprint ${task.sprintNumber} complete for goal ${task.goalId} — waking supervisor immediately.`);
            // Atomically claim the sprint wake before launching the blocking
            // supervisor run. This prevents immediate, timer, comment, and
            // reconciliation paths from planning the same next sprint in parallel.
            const claimed = await claimSprintWakeUp(this.sql, task.goalId, task.sprintNumber);
            if (!claimed) {
              console.log(
                `[dispatcher] Sprint ${task.sprintNumber} wake for goal ${task.goalId} already claimed — skipping duplicate immediate wake.`,
              );
              return;
            }
            let wakeOk = false;
            try {
              const lockedWake = await withGoalSupervisorWakeLock(this.sql, task.goalId, async () => {
                const { wakeUpSupervisor } = await import("../goals/supervisor");
                return await wakeUpSupervisor(this.sql, task.goalId!, task.sprintNumber!);
              });
              if (!lockedWake.acquired) {
                console.log(
                  `[dispatcher] Supervisor wake already in flight for goal ${task.goalId} — coalescing immediate sprint ${task.sprintNumber} wake.`,
                );
                wakeOk = true;
              } else if (lockedWake.result.success) {
                wakeOk = true;
              } else {
                console.error(`[dispatcher] Immediate supervisor wake-up failed: ${lockedWake.result.error}`);
              }
            } finally {
              if (!wakeOk) {
                await revertSprintWakeUp(this.sql, task.goalId, task.sprintNumber);
              }
            }
          }
        } catch (sprintErr) {
          console.error("[dispatcher] Immediate sprint check error:", sprintErr);
        }
      }

    } catch (err) {
      console.error("[dispatcher] Error processing task:", err);
    }
  }

  private async runWatchdog() {
    try {
      const stuck = await findStuckTasks(
        this.sql,
        this.config.heartbeatTimeoutMs,
        this.config.maxTaskRuntimeMs,
      );
      for (const task of stuck) {
        const reasonText =
          task.reason === "max_runtime_exceeded"
            ? `Watchdog: task exceeded max runtime (${Math.round(this.config.maxTaskRuntimeMs / 60_000)} min)`
            : "Watchdog: no heartbeat within timeout period";
        console.log(
          `[dispatcher] Watchdog: task ${task.id} (${task.title}) appears stuck — ${task.reason}.`,
        );
        await handleTaskFailureAndDoctor(
          this.sql,
          task.id,
          FailureCategory.AgentTimeout,
          reasonText,
          this.config,
        );
      }

      // Rescue dev tasks wedged in `in_review` because their [QA] Review child
      // hit a terminal failure. Without this the goal silently freezes — the
      // supervisor wake condition skips goals with any `in_review` task.
      const deadEnds = await findDeadEndReviewTasks(this.sql);
      for (const t of deadEnds) {
        const reason = `QA infrastructure failure (child ${t.failedQaChildId}): ${t.failedQaReason ?? "unknown"}`;
        console.log(
          `[dispatcher] Watchdog: rescuing in_review task ${t.id} — child QA terminally failed; marking failed and triggering supervisor replan.`,
        );
        await this.sql`
          UPDATE tasks SET status = 'failed', failure_reason = ${reason}, updated_at = NOW()
          WHERE id = ${t.id}
        `;
        await notifyGoalSupervisorOfQaFailure(this.sql, t.id, reason);
      }

      // Rescue tasks that have been `blocked` for over 2x maxTaskRuntimeMs
      // with no in-flight repair child. These represent doctor `fix_environment`
      // dead ends or owner-decision tasks that never resolved.
      const blockedAgeMs = this.config.maxTaskRuntimeMs * 2;
      const stuckBlocked = await findStuckBlockedTasks(this.sql, blockedAgeMs);
      for (const t of stuckBlocked) {
        const minutes = Math.round(t.blockedSinceMs / 60_000);
        console.log(
          `[dispatcher] Watchdog: blocked task ${t.id} (${t.title}) has had no resolving child for ${minutes}min (${t.reason}) — escalating.`,
        );
        const blockedReason = t.reason === "fast_terminal_failure"
          ? "Watchdog: fast terminal adapter/preflight failure with no resolving child"
          : `Watchdog: blocked >${Math.round(blockedAgeMs / 60_000)}min with no resolving child`;
        if (t.goalId) {
          // Goal-attached blocked tasks go through supervisor replan so the
          // goal can move on rather than dying.
          await this.sql`
            UPDATE tasks SET status = 'failed',
                             failure_reason = ${`${blockedReason} (was: ${t.failureReason ?? "unknown"})`},
                             updated_at = NOW()
            WHERE id = ${t.id}
          `;
          await notifyGoalSupervisorOfQaFailure(this.sql, t.id, t.failureReason ?? "Blocked indefinitely; original cause unclear.");
        } else {
          // Standalone blocked tasks just get marked failed — the regular
          // failure-handler will route through doctor / decision pipeline.
          await handleTaskFailureAndDoctor(
            this.sql,
            t.id,
            FailureCategory.AgentTimeout,
            blockedReason,
            this.config,
          );
        }
      }
    } catch (err) {
      console.error("[dispatcher] Watchdog error:", err);
    }
  }

  private async runScheduleCheck() {
    try {
      const count = await checkAndFireSchedules(this.sql);
      if (count > 0) {
        console.log(`[dispatcher] Schedule timer: created ${count} task(s).`);
      }
    } catch (err) {
      console.error("[dispatcher] Schedule timer error:", err);
    }
  }

  private async runModelDiscoveryCheck() {
    if (this.modelDiscoveryBusy) return;
    this.modelDiscoveryBusy = true;
    try {
      await runScheduledModelDiscovery(this.sql);
    } catch (err) {
      console.error("[dispatcher] Model discovery timer error:", err);
    } finally {
      this.modelDiscoveryBusy = false;
    }
  }

  private async runModelHealthRenewalCheck() {
    try {
      await runSystemModelHealthRenewal(this.sql, {
        encryptionKey: process.env.ENCRYPTION_KEY,
      });
    } catch (err) {
      console.error("[dispatcher] model health renewal failed:", err);
    }
  }

  private async runSupervisorWakeReconciliationCheck() {
    try {
      const result = await runSupervisorWakeReconciliation(
        this.sql,
        this.supervisorWakeReconciliationState,
      );
      if (result.candidates > 0) {
        console.log(
          `[dispatcher] Supervisor wake reconciliation: candidates=${result.candidates} fired=${result.fired} skipped=${result.skipped} failed=${result.failed}.`,
        );
      }
    } catch (err) {
      console.error("[dispatcher] Supervisor wake reconciliation error:", err);
    }
  }

  private async runDashboardHealerCheck() {
    try {
      await runDashboardHealerTick(
        createDefaultDashboardHealerDeps(),
        this.dashboardHealerState,
      );
    } catch (err) {
      console.error("[dashboard-healer] tick-failed:", err);
    }
  }

  private async handleNewGoalComment(commentId: string) {
    try {
      const [comment] = await this.sql<
        { id: string; goal_id: string; body: string; created_by: string }[]
      >`
        SELECT id, goal_id, body, created_by
        FROM goal_comments
        WHERE id = ${commentId}
      `;
      if (!comment) {
        console.log(`[dispatcher] goal-comment ${commentId} not found — ignoring notify.`);
        return;
      }
      // Skip comments the supervisor itself posted — otherwise its reply
      // would re-trigger the wake and loop forever.
      if (comment.created_by === "goal-supervisor") {
        return;
      }
      const [goal] = await this.sql<
        { id: string; session_id: string | null; status: string }[]
      >`SELECT id, session_id, status FROM goals WHERE id = ${comment.goal_id}`;
      if (!goal) return;
      if (goal.status !== "active") {
        console.log(
          `[dispatcher] goal ${goal.id} is not active (status=${goal.status}); skipping comment wake.`,
        );
        return;
      }
      if (!goal.session_id) {
        console.log(
          `[dispatcher] goal ${goal.id} has no supervisor session yet; comment will be picked up when supervisor starts.`,
        );
        return;
      }
      const lockedWake = await withGoalSupervisorWakeLock(this.sql, goal.id, async () => {
        const { wakeUpSupervisorOnComment } = await import("../goals/supervisor");
        return await wakeUpSupervisorOnComment(this.sql, goal.id, comment.id);
      });
      if (!lockedWake.acquired) {
        console.log(
          `[dispatcher] Supervisor wake already in flight for goal ${goal.id}; coalescing comment ${comment.id}.`,
        );
        return;
      }
      const result = lockedWake.result;
      if (result.error) {
        console.error(
          `[dispatcher] comment wake-up failed for goal ${goal.id} comment ${comment.id}: ${result.error}`,
        );
      } else {
        console.log(
          `[dispatcher] Comment wake-up complete for goal ${goal.id} (comment ${comment.id}).`,
        );
      }
    } catch (err) {
      console.error(`[dispatcher] handleNewGoalComment error for ${commentId}:`, err);
    }
  }

  private async handleNewDecisionMessage(messageId: string) {
    try {
      const result = await mirrorOwnerDecisionCommentToGoalComment(this.sql, messageId);
      if (result.status === "mirrored") {
        console.log(
          `[dispatcher] Mirrored owner decision-message ${messageId} to goal-comment ${result.goalCommentId} for goal ${result.goalId}.`,
        );
      } else {
        console.log(
          `[dispatcher] decision-message ${messageId} did not wake supervisor: ${result.reason}.`,
        );
      }
    } catch (err) {
      console.error(`[dispatcher] handleNewDecisionMessage error for ${messageId}:`, err);
    }
  }

  private async processPendingDecisionOwnerComments() {
    const pending = await findPendingOwnerDecisionComments(this.sql);
    if (pending.length === 0) return;
    console.log(
      `[dispatcher] Fallback found ${pending.length} pending owner decision-comment wake(s).`,
    );
    for (const message of pending) {
      await this.handleNewDecisionMessage(message.messageId);
    }
  }

  private async runGoalLifecycleCheck() {
    try {
      await this.processPendingDecisionOwnerComments();

      // 1. Check for new goals that need supervisors
      const newGoals = await findNewGoals(this.sql);
      for (const goal of newGoals) {
        console.log(`[dispatcher] New goal detected: ${goal.id} (${goal.title})`);

        // Owner-facing acknowledgement on the way in — fires through every
        // active discord-webhook / notification_preferences row for this
        // hive. Sent before startGoalSupervisor so the owner gets
        // immediate feedback even if the supervisor is slow to spawn.
        sendNotification(this.sql, {
          hiveId: goal.hiveId,
          title: `New goal received: ${goal.title}`,
          message: buildGoalCreatedNotificationMessage(goal.description),
          priority: "normal",
          source: "goal-intake",
        }).catch((err) => console.error(`[dispatcher] New-goal notification failed for ${goal.id}:`, err));

        try {
          const lockedStart = await withGoalSupervisorWakeLock(this.sql, goal.id, async () => {
            const { startGoalSupervisor } = await import("../goals/supervisor");
            return await startGoalSupervisor(this.sql, goal.id);
          });
          if (!lockedStart.acquired) {
            console.log(
              `[dispatcher] Supervisor start already in flight for goal ${goal.id}; skipping duplicate new-goal start.`,
            );
            continue;
          }
          const result = lockedStart.result;
          if (result.error) {
            console.error(`[dispatcher] Failed to start supervisor for goal ${goal.id}: ${result.error}`);
          } else {
            console.log(`[dispatcher] Supervisor started: ${result.agentId} for goal ${goal.id}`);
          }
        } catch (err) {
          console.error(`[dispatcher] Supervisor creation error for goal ${goal.id}:`, err);
        }
      }

      // 2. Check for completed sprints that need supervisor wake-up
      const completedSprints = await findCompletedSprintsForWakeUp(this.sql);
      for (const sprint of completedSprints) {
        console.log(`[dispatcher] Sprint ${sprint.sprintNumber} complete for goal ${sprint.goalId}`);
        // Mark before waking — wakeUpSupervisor blocks for up to 5 minutes and the
        // timer-based lifecycle check could otherwise fire again and create a second
        // wake-up for the same sprint before the first one finishes. If the wake
        // call fails (or the dispatcher dies mid-call), revertSprintWakeUp rolls
        // last_woken_sprint back so the next poll re-detects this sprint.
        const claimed = await claimSprintWakeUp(this.sql, sprint.goalId, sprint.sprintNumber);
        if (!claimed) {
          console.log(
            `[dispatcher] Sprint ${sprint.sprintNumber} wake for goal ${sprint.goalId} already claimed — skipping duplicate lifecycle wake.`,
          );
          continue;
        }
        let wakeOk = false;
        try {
          const lockedWake = await withGoalSupervisorWakeLock(this.sql, sprint.goalId, async () => {
            const { wakeUpSupervisor } = await import("../goals/supervisor");
            return await wakeUpSupervisor(this.sql, sprint.goalId, sprint.sprintNumber);
          });
          if (!lockedWake.acquired) {
            console.log(
              `[dispatcher] Supervisor wake already in flight for goal ${sprint.goalId}; coalescing lifecycle sprint ${sprint.sprintNumber} wake.`,
            );
            wakeOk = true;
          } else if (lockedWake.result.success) {
            wakeOk = true;
            console.log(`[dispatcher] Supervisor wake-up sent for goal ${sprint.goalId}: ${lockedWake.result.output.slice(0, 200)}`);
          } else {
            console.error(`[dispatcher] Supervisor wake-up failed for goal ${sprint.goalId}: ${lockedWake.result.error}`);
          }
        } catch (err) {
          console.error(`[dispatcher] Sprint wake-up error for goal ${sprint.goalId}:`, err);
        } finally {
          if (!wakeOk) {
            await revertSprintWakeUp(this.sql, sprint.goalId, sprint.sprintNumber);
          }
        }

        // After wake-up, check if compaction is needed (based on completed sprint count)
        try {
          const [sprintCount] = await this.sql`
            SELECT COUNT(DISTINCT sprint_number)::int AS count FROM tasks
            WHERE goal_id = ${sprint.goalId} AND status = 'completed' AND sprint_number IS NOT NULL
          `;

          if ((sprintCount?.count ?? 0) >= 10) {
            console.log(`[dispatcher] Goal ${sprint.goalId} has ${sprintCount.count} sprints, triggering compaction`);
            const { buildCompactionRequest, buildCompactedSessionPrompt } = await import("../goals/compaction");
            const { terminateGoalSupervisor, startGoalSupervisor } = await import("../goals/supervisor");

            // Run compaction via a wake-up with a compaction prompt appended
            const [goalData] = await this.sql`SELECT id, hive_id FROM goals WHERE id = ${sprint.goalId}`;
            const [biz] = await this.sql`SELECT slug FROM hives WHERE id = ${goalData.hive_id}`;
            const bizSlug = (biz?.slug as string) || "default";
            const workspacePath = hiveGoalWorkspacePath(bizSlug, sprint.goalId);

            const compactionRequest = buildCompactionRequest();
            const agentsMdPath = `${workspacePath}/AGENTS.md`;
            const fs = await import("fs");
            const existingContent = fs.existsSync(agentsMdPath)
              ? fs.readFileSync(agentsMdPath, "utf-8")
              : "";
            fs.writeFileSync(
              agentsMdPath,
              existingContent + `\n\n---\n\n## Compaction Request\n\n${compactionRequest}`,
              "utf-8",
            );

            // Terminate old agent and restart with compacted context
            const originalPrompt = await buildSupervisorInitialPrompt(this.sql, sprint.goalId);
            const resumedPrompt = buildCompactedSessionPrompt(originalPrompt, "[See compaction results in workspace]");

            await terminateGoalSupervisor(this.sql, sprint.goalId);
            // Write the compacted prompt as the new AGENTS.md
            const { title: goalTitle } = (await this.sql`SELECT title FROM goals WHERE id = ${sprint.goalId}`)[0] ?? { title: "Goal" };
            fs.writeFileSync(
              agentsMdPath,
              `# Goal Supervisor (Resumed)\n\n## Goal: ${goalTitle}\n\n${resumedPrompt}\n`,
              "utf-8",
            );
            const compactResult = await startGoalSupervisor(this.sql, sprint.goalId);
            if (compactResult.error) {
              console.error(`[dispatcher] Compaction restart failed for goal ${sprint.goalId}: ${compactResult.error}`);
            } else {
              console.log(`[dispatcher] Compacted goal ${sprint.goalId} to new agent: ${compactResult.agentId}`);
            }
          }
        } catch (compErr) {
          console.error(`[dispatcher] Compaction check error for goal ${sprint.goalId}:`, compErr);
        }
      }
    } catch (err) {
      console.error("[dispatcher] Goal lifecycle check error:", err);
    }
  }

  async checkSprints() {
    await this.runGoalLifecycleCheck();
  }

  private async resolveAdapter(adapterType: string): Promise<Adapter> {
    switch (adapterType) {
      case "openclaw": {
        const { OpenClawAdapter } = await import("../adapters/openclaw");
        return new OpenClawAdapter();
      }
      case "ollama": {
        const { OllamaAdapter } = await import("../adapters/ollama");
        return new OllamaAdapter();
      }
      case "claude-code":
        return new ClaudeCodeAdapter();
      case "codex": {
        const { CodexAdapter } = await import("../adapters/codex");
        return new CodexAdapter(this.sql);
      }
      case "gemini": {
        const { GeminiAdapter } = await import("../adapters/gemini");
        return new GeminiAdapter();
      }
      case "openai-image": {
        const { OpenAIImageAdapter } = await import("../adapters/openai-image");
        return new OpenAIImageAdapter();
      }
      default:
        return new ClaudeCodeAdapter();
    }
  }

  /**
   * Require fresh model-health evidence and then ask the adapter provisioner
   * whether the runtime is currently reachable. Used to pre-emptively swap to
   * a fallback adapter before we spend time on a doomed spawn.
   *
   * Errors are treated as "unhealthy" rather than thrown so a transient
   * endpoint hiccup doesn't break the whole dispatch cycle.
   */
  private async isAdapterHealthy(
    adapterType: string,
    slug: string,
    model: string,
    hiveId: string,
  ): Promise<boolean> {
    try {
      const status = await checkDispatcherModelRouteHealth(this.sql, {
        hiveId,
        roleSlug: slug,
        adapterType,
        modelId: model,
      });
      if (!status.healthy) {
        console.warn(
          `[dispatcher] model route health blocked ${adapterType}/${model}: ${status.reason}${status.detail ? ` (${status.detail})` : ""}`,
        );
      }
      return status.healthy;
    } catch (err) {
      console.warn(
        `[dispatcher] model route health check failed for ${adapterType}/${model}:`,
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  private async runSynthesisCheck() {
    try {
      const hives = await this.sql`SELECT id FROM hives`;
      for (const biz of hives) {
        const should = await shouldRunSynthesis(this.sql, biz.id as string);
        if (should) {
          console.log(`[dispatcher] Running synthesis for hive ${biz.id}...`);
          const result = await runSynthesis(this.sql, biz.id as string, getModelConfig());
          console.log(
            `[dispatcher] Synthesis complete: ${result.workProductsProcessed} WPs, ${result.pairsAnalyzed} pairs, ${result.insightsCreated} insights`
          );
        }

        // Curate freshly synthesized insights: auto-promote, escalate, dismiss
        // or acknowledge so the inbox doesn't accumulate. See src/insights/curator.ts.
        try {
          const curated = await runInsightCurator(this.sql, biz.id as string);
          const total =
            curated.promoted + curated.escalated + curated.dismissed + curated.acknowledged;
          if (total > 0) {
            console.log(
              `[dispatcher] Insight curator: ${curated.promoted} promoted, ` +
                `${curated.escalated} escalated, ${curated.dismissed} dismissed, ` +
                `${curated.acknowledged} acknowledged (hive ${biz.id})`,
            );
          }
        } catch (curErr) {
          console.error("[dispatcher] Insight curator error:", curErr);
        }

        // Check for role evolution candidates
        try {
          const { findEvolutionCandidates, proposeRoleUpdate } = await import("../memory/role-evolution");
          const candidates = await findEvolutionCandidates(this.sql, biz.id as string);
          for (const candidate of candidates) {
            await proposeRoleUpdate(this.sql, candidate);
          }
        } catch (evolErr) {
          console.error("[dispatcher] Role evolution check error:", evolErr);
        }
      }
    } catch (err) {
      console.error("[dispatcher] Synthesis check error:", err);
    }
  }

  private async checkCredentialExpiry() {
    try {
      const expiring = await this.sql`
        SELECT c.id, c.name, c.key, c.hive_id, c.expires_at, b.name AS hive_name
        FROM credentials c
        LEFT JOIN hives b ON b.id = c.hive_id
        WHERE c.expires_at IS NOT NULL
          AND c.expires_at <= NOW() + INTERVAL '7 days'
          AND c.expires_at > NOW()
          AND NOT EXISTS (
            SELECT 1 FROM decisions d
            WHERE d.title LIKE '%' || c.name || '%'
              AND d.status = 'pending'
          )
      `;
      for (const cred of expiring) {
        const daysLeft = Math.ceil(
          (new Date(cred.expires_at as string).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        );
        // Route through EA-first: the resolver may handle credential
        // refresh autonomously (e.g. a connector that supports OAuth
        // refresh) or escalate to the owner with a plain-English ask.
        // No direct sendNotification here — the EA fires it after
        // escalating with rewritten owner-facing text.
        await this.sql`
          INSERT INTO decisions (hive_id, title, context, recommendation, priority, status)
          VALUES (
            ${cred.hive_id},
            ${'Credential expiring: ' + cred.name},
            ${'The credential "' + cred.name + '" (' + cred.key + ') for hive "' + (cred.hive_name || 'system-wide') + '" expires in ' + daysLeft + ' days. Please provide a renewed credential.'},
            'Renew this credential before it expires to avoid agent failures.',
            'urgent',
            'ea_review'
          )
        `;
        console.log(`[dispatcher] Created ea_review decision for credential: ${cred.name} (${daysLeft} days left)`);
      }
    } catch (err) {
      console.error("[dispatcher] Credential expiry check error:", err);
    }
  }

  private async checkDecisionEscalation() {
    try {
      const stale = await this.sql`
        SELECT d.id, d.hive_id, d.title, d.context, d.priority
        FROM decisions d
        WHERE d.priority = 'urgent'
          AND d.status = 'pending'
          AND d.created_at < NOW() - INTERVAL '4 hours'
          AND NOT EXISTS (
            SELECT 1 FROM decision_messages dm
            WHERE dm.decision_id = d.id
            AND dm.created_at > NOW() - INTERVAL '4 hours'
          )
      `;
      for (const d of stale) {
        await sendNotification(this.sql, {
          hiveId: d.hive_id as string,
          title: `ESCALATION: ${d.title}`,
          message: `This urgent decision has been pending for over 4 hours: ${d.context}`,
          priority: "urgent",
          source: "dispatcher",
        });
        console.log(`[dispatcher] Escalated stale decision: ${d.id}`);
      }
    } catch (err) {
      console.error("[dispatcher] Decision escalation check failed:", err);
    }
  }

  /**
   * EA-first decision pipeline. Picks one ea_review decision at a time
   * (claude-code spawns are expensive and we don't want N owner-decisions
   * spawning N agents in parallel) and hands it to the EA resolver.
   *
   * The resolver invokes a headless `claude --print` agent with full
   * shell + curl access. It either auto-resolves the decision (cancel
   * orphan task, retry with new role, etc.) or rewrites it into plain
   * English and escalates to status='pending' for the owner.
   *
   * Decisions stuck after MAX_EA_ATTEMPTS (malformed output / EA crash /
   * repeated needs_more_info) are forcibly escalated to the owner with
   * the original context preserved.
   */
  private async runEaReviewPass() {
    if (this.eaReviewBusy || this.shuttingDown) return;
    this.eaReviewBusy = true;
    try {
      const { resolveDecisionViaEa, applyEaResolution, forceEscalateAfterEaFailure, MAX_EA_ATTEMPTS } =
        await import("../decisions/ea-resolver");

      // Drain — usually 0 or 1, occasionally a small batch on boot if
      // many decisions queued while the dispatcher was down.
      while (!this.shuttingDown) {
        const [row] = await this.sql<{
          id: string;
          hive_id: string;
          goal_id: string | null;
          task_id: string | null;
          title: string;
          context: string;
          recommendation: string | null;
          priority: string;
          kind: string;
          ea_attempts: number;
        }[]>`
          SELECT id, hive_id, goal_id, task_id, title, context, recommendation,
                 priority, kind, ea_attempts
          FROM decisions
          WHERE status = 'ea_review'
          ORDER BY created_at ASC
          LIMIT 1
        `;
        if (!row) break;

        if (row.ea_attempts >= MAX_EA_ATTEMPTS) {
          await forceEscalateAfterEaFailure(this.sql, row.id, "max EA attempts exhausted");
          await this.outboundNotifier?.scanAndQueue();
          console.log(`[dispatcher] Forcibly escalated decision ${row.id} after MAX_EA_ATTEMPTS retries`);
          continue;
        }

        console.log(`[dispatcher] EA reviewing decision ${row.id} (attempt ${row.ea_attempts + 1}/${MAX_EA_ATTEMPTS})`);
        const outcome = await resolveDecisionViaEa(this.sql, {
          decisionId: row.id,
          hiveId: row.hive_id,
          goalId: row.goal_id,
          taskId: row.task_id,
          title: row.title,
          context: row.context,
          recommendation: row.recommendation,
          priority: row.priority,
          kind: row.kind,
        });

        if (!outcome.ok) {
          // Bump attempts so we eventually force-escalate. If this was
          // attempt 1 and we still have a retry left, the row stays in
          // ea_review for the next pass.
          await this.sql`
            UPDATE decisions
            SET ea_attempts = ea_attempts + 1,
                ea_reasoning = ${`EA resolver failed: ${outcome.reason}`},
                ea_decided_at = NOW()
            WHERE id = ${row.id}
          `;
          console.warn(`[dispatcher] EA resolver failed for ${row.id}: ${outcome.reason}`);
          if (row.ea_attempts + 1 >= MAX_EA_ATTEMPTS) {
            await forceEscalateAfterEaFailure(this.sql, row.id, outcome.reason);
            await this.outboundNotifier?.scanAndQueue();
            console.log(`[dispatcher] Forcibly escalated decision ${row.id} after retry exhaustion`);
          }
          continue;
        }

        await applyEaResolution(this.sql, row.id, outcome.result);

        if (outcome.result.action === "auto_resolve") {
          console.log(`[dispatcher] EA auto-resolved decision ${row.id}: ${outcome.result.reasoning.slice(0, 200)}`);
        } else if (outcome.result.action === "escalate_to_owner") {
          console.log(`[dispatcher] EA escalated decision ${row.id} to owner: ${outcome.result.ownerTitle}`);
          // Owner-facing notification is fired here, with the EA's
          // rewritten plain-English context (NOT the original technical
          // dump) so push messages stay readable.
          await sendNotification(this.sql, {
            hiveId: row.hive_id,
            title: outcome.result.ownerTitle ?? row.title,
            message: outcome.result.ownerContext ?? row.context,
            priority: outcome.result.ownerPriority ?? "normal",
            source: "ea-decision",
          }).catch((err) => console.error(`[dispatcher] EA-escalation notification failed for ${row.id}:`, err));
          await this.outboundNotifier?.scanAndQueue();
        } else {
          console.log(`[dispatcher] EA needs more info on decision ${row.id} — will retry`);
        }
      }
    } catch (err) {
      console.error("[dispatcher] EA review pass error:", err);
    } finally {
      this.eaReviewBusy = false;
    }
  }

  private async runOutboundNotifierScan() {
    try {
      await this.outboundNotifier?.scanAndQueue();
    } catch (err) {
      console.error("[dispatcher] Outbound notifier scan failed:", err);
    }
  }

  private async runImprovementSweep() {
    try {
      const { runImprovementSweep } = await import("../improvement/sweeper");
      const results = await runImprovementSweep(this.sql);
      const proposals = results.reduce(
        (acc, r) =>
          acc +
          r.evolutionProposals +
          r.reliabilityProposals +
          r.efficiencyProposals,
        0,
      );
      const errors = results.reduce((acc, r) => acc + r.errors.length, 0);
      console.log(
        `[dispatcher] Improvement sweep: ${results.length} hive(s), ${proposals} proposal(s), ${errors} error(s).`,
      );
    } catch (err) {
      console.error("[dispatcher] Improvement sweep failed:", err);
    }
  }

  private async seedDefaultSchedulesForAllHives() {
    try {
      const { seedDefaultSchedules } = await import("../hives/seed-schedules");
      const hives = await this.sql<
        { id: string; name: string; description: string | null }[]
      >`
        SELECT id, name, description FROM hives
      `;
      let created = 0;
      for (const h of hives) {
        const r = await seedDefaultSchedules(this.sql, h);
        created += r.created;
      }
      if (created > 0) {
        console.log(
          `[dispatcher] Seeded default schedules for ${created} hive(s).`,
        );
      }
    } catch (err) {
      console.error("[dispatcher] Default schedule seeding failed:", err);
    }
  }

  /**
   * Read the dispatcher-wide concurrency cap from adapter_config so it can be
   * tuned live from the Roles dashboard without a restart. When dynamic
   * concurrency is enabled, maxConcurrentTasks becomes the owner's manual
   * ceiling and local CPU/RAM/GPU pressure moves the effective cap inside that
   * bound.
   */
  private async getLiveMaxConcurrent(): Promise<number> {
    try {
      const [row] = await this.sql<{ config: unknown }[]>`
        SELECT config
        FROM adapter_config
        WHERE adapter_type = 'dispatcher' AND hive_id IS NULL
        LIMIT 1
      `;
      const rawConfig = row?.config && typeof row.config === "object"
        ? row.config as Record<string, unknown>
        : {};
      const manualMax = Number(rawConfig.maxConcurrentTasks);
      const maxConcurrentTasks = Number.isFinite(manualMax) && manualMax >= 1 && manualMax <= 100
        ? Math.round(manualMax)
        : this.config.maxConcurrentTasks;
      const dynamicConfig = normalizeDynamicConcurrencyConfig(rawConfig.dynamicConcurrency);
      if (!dynamicConfig.enabled) {
        this.dynamicConcurrencyCap = null;
        return maxConcurrentTasks;
      }

      const snapshot = await readLocalCapacitySnapshot();
      const nextCap = calculateDynamicConcurrencyCap({
        manualMaxConcurrentTasks: maxConcurrentTasks,
        currentCap: this.dynamicConcurrencyCap ?? maxConcurrentTasks,
        config: dynamicConfig,
        snapshot,
      });

      if (this.dynamicConcurrencyCap !== nextCap) {
        console.log(
          `[dispatcher] Dynamic concurrency cap now ${nextCap}/${maxConcurrentTasks} ` +
          `(cpu=${snapshot.cpuPercent.toFixed(0)}%, mem=${snapshot.memoryPercent.toFixed(0)}%` +
          `${snapshot.gpuPercent === undefined ? "" : `, gpu=${snapshot.gpuPercent.toFixed(0)}%`})`,
        );
      }
      this.dynamicConcurrencyCap = nextCap;
      return nextCap;
    } catch (err) {
      console.warn("[dispatcher] live max-concurrent read failed; using bundled default:", err);
    }
    return this.config.maxConcurrentTasks;
  }

  /**
   * Wait for in-flight tasks to drain, then schedule a deferred restart
   * via the existing helper so any in-flight EA reply has time to ship
   * before SIGTERM lands. systemd's Restart=always policy on the unit
   * brings the dispatcher back up with the freshly-built bundle.
   *
   * Idempotent: only schedules the restart once per dispatcher boot.
   * Bounded: caps at 10 minutes so a stuck task can't block the deploy
   * indefinitely — the watchdog re-claims that task when the new
   * dispatcher boots.
   */
  private async attemptDrainExit() {
    if (this.restartScheduled) return;

    const startedAt = Date.now();
    const MAX_DRAIN_MS = 10 * 60_000;
    const POLL_MS = 5_000;

    while (this.activeTasks > 0 && Date.now() - startedAt < MAX_DRAIN_MS) {
      console.log(`[dispatcher] Draining: ${this.activeTasks} task(s) still active; waiting…`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    if (this.activeTasks > 0) {
      console.warn(
        `[dispatcher] Drain timeout (10 min) with ${this.activeTasks} task(s) still active — restarting anyway. Stuck tasks will be re-claimed by the watchdog after boot.`,
      );
    } else {
      console.log("[dispatcher] Drain complete; scheduling deferred restart.");
    }

    this.restartScheduled = true;
    // Deferred-restart helper schedules a transient systemd timer that
    // survives the SIGTERM the dispatcher will receive — so any
    // in-flight EA reply still ships before the cycle.
    const child = spawn("./scripts/deferred-restart-dispatcher.sh", ["10"], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) => {
      console.error("[dispatcher] deferred-restart-dispatcher.sh failed to launch:", err);
    });
    child.unref();
  }

  async shutdown() {
    console.log("[dispatcher] Shutting down gracefully...");
    this.shuttingDown = true;

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    if (this.modelDiscoveryTimer) clearInterval(this.modelDiscoveryTimer);
    if (this.modelHealthRenewalTimer) clearInterval(this.modelHealthRenewalTimer);
    if (this.sprintCheckTimer) clearInterval(this.sprintCheckTimer);
    if (this.supervisorWakeReconciliationTimer) {
      clearInterval(this.supervisorWakeReconciliationTimer);
    }
    if (this.synthesisTimer) clearInterval(this.synthesisTimer);
    if (this.credentialCheckTimer) clearInterval(this.credentialCheckTimer);
    if (this.escalationTimer) clearInterval(this.escalationTimer);
    if (this.eaReviewTimer) clearInterval(this.eaReviewTimer);
    if (this.outboundNotifierTimer) clearInterval(this.outboundNotifierTimer);
    this.outboundNotifier?.stop();
    if (this.improvementTimer) clearInterval(this.improvementTimer);
    if (this.dashboardHealerTimer) clearInterval(this.dashboardHealerTimer);
    if (this.taskListener) await this.taskListener.unlisten();
    for (const cb of this.shutdownCallbacks) { try { await cb(); } catch { /* ignore */ } }
    if (this.roleWatcher) await this.roleWatcher.close();
    if (this.bundleWatcher) await this.bundleWatcher.stop();

    await this.sql.end();
    console.log("[dispatcher] Shutdown complete.");
    process.exit(0);
  }
}

// Run if executed directly
const isMainModule = process.argv[1]?.includes("dispatcher");
if (isMainModule) {
  const dispatcher = new Dispatcher();
  dispatcher.start().catch((err) => {
    console.error("[dispatcher] Fatal error:", err);
    process.exit(1);
  });
}
