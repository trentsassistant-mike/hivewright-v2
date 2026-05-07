import type { Sql } from "postgres";
import { resolveGoalSupervisorRuntime, type SupervisorBackend } from "./supervisor-routing";

/**
 * Adapter-aware shim for the goal supervisor lifecycle. Resolves the
 * goal-supervisor runtime through dashboard/model-routing config and routes
 * start/wake/terminate to the matching persistent-session backend.
 */

async function pickBackend(sql: Sql, goalId: string): Promise<SupervisorBackend> {
  const runtime = await resolveGoalSupervisorRuntime(sql, goalId);
  return runtime.backend;
}

export async function startGoalSupervisor(sql: Sql, goalId: string): Promise<{ agentId: string; error?: string }> {
  let backend: SupervisorBackend;
  try {
    backend = await pickBackend(sql, goalId);
  } catch (error) {
    return {
      agentId: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const mod = backend === "codex"
    ? await import("./supervisor-codex")
    : await import("./supervisor-openclaw");
  return mod.startGoalSupervisor(sql, goalId);
}

export async function wakeUpSupervisor(
  sql: Sql,
  goalId: string,
  sprintNumber: number,
): Promise<{ success: boolean; output: string; error?: string }> {
  let backend: SupervisorBackend;
  try {
    backend = await pickBackend(sql, goalId);
  } catch (error) {
    return {
      success: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const mod = backend === "codex"
    ? await import("./supervisor-codex")
    : await import("./supervisor-openclaw");
  return mod.wakeUpSupervisor(sql, goalId, sprintNumber);
}

export async function wakeUpSupervisorOnComment(
  sql: Sql,
  goalId: string,
  commentId: string,
): Promise<{ success: boolean; output: string; error?: string }> {
  let backend: SupervisorBackend;
  try {
    backend = await pickBackend(sql, goalId);
  } catch (error) {
    return {
      success: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (backend === "codex") {
    const mod = await import("./supervisor-codex");
    return mod.wakeUpSupervisorOnComment(sql, goalId, commentId);
  }
  // Comment wake-up is only implemented for the codex backend so far —
  // the openclaw supervisor is being retired. Return a structured no-op
  // rather than failing, so an openclaw-configured goal with a new comment
  // doesn't crash the dispatcher's NOTIFY handler.
  return {
    success: false,
    output: "",
    error: "wakeUpSupervisorOnComment is only implemented for the codex backend",
  };
}

export async function terminateGoalSupervisor(sql: Sql, goalId: string): Promise<void> {
  const backend = await pickBackend(sql, goalId);
  const mod = backend === "codex"
    ? await import("./supervisor-codex")
    : await import("./supervisor-openclaw");
  return mod.terminateGoalSupervisor(sql, goalId);
}
