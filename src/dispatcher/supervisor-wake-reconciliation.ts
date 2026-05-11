import type { Sql } from "postgres";
import { findSupervisorWakeReconciliationCandidates, withGoalSupervisorWakeLock } from "./goal-lifecycle";

export interface SupervisorWakeReconciliationState {
  inFlight: Set<string>;
  fired: Set<string>;
}

export interface SupervisorWakeReconciliationResult {
  candidates: number;
  fired: number;
  skipped: number;
  failed: number;
}

export function createSupervisorWakeReconciliationState(): SupervisorWakeReconciliationState {
  return {
    inFlight: new Set(),
    fired: new Set(),
  };
}

function reconciliationKey(goalId: string, sprintNumber: number): string {
  return `${goalId}:${sprintNumber}`;
}

export async function runSupervisorWakeReconciliation(
  sql: Sql,
  state: SupervisorWakeReconciliationState,
  staleAfterMinutes = 2,
): Promise<SupervisorWakeReconciliationResult> {
  const candidates = await findSupervisorWakeReconciliationCandidates(sql, staleAfterMinutes);
  const result: SupervisorWakeReconciliationResult = {
    candidates: candidates.length,
    fired: 0,
    skipped: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    const key = reconciliationKey(candidate.goalId, candidate.sprintNumber);
    if (state.fired.has(key) || state.inFlight.has(key)) {
      result.skipped++;
      continue;
    }

    state.inFlight.add(key);
    try {
      const lockedWake = await withGoalSupervisorWakeLock(sql, candidate.goalId, async () => {
        const { wakeUpSupervisor } = await import("../goals/supervisor");
        return await wakeUpSupervisor(sql, candidate.goalId, candidate.sprintNumber);
      });
      if (!lockedWake.acquired) {
        result.skipped++;
        console.log(
          `[dispatcher] Supervisor wake reconciliation skipped for goal ${candidate.goalId} sprint ${candidate.sprintNumber}: supervisor already in flight.`,
        );
        continue;
      }
      const wakeResult = lockedWake.result;
      if (wakeResult.success) {
        state.fired.add(key);
        result.fired++;
      } else {
        result.failed++;
        console.error(
          `[dispatcher] Supervisor wake reconciliation failed for goal ${candidate.goalId} sprint ${candidate.sprintNumber}: ${wakeResult.error}`,
        );
      }
    } catch (err) {
      result.failed++;
      console.error(
        `[dispatcher] Supervisor wake reconciliation error for goal ${candidate.goalId} sprint ${candidate.sprintNumber}:`,
        err,
      );
    } finally {
      state.inFlight.delete(key);
    }
  }

  return result;
}
