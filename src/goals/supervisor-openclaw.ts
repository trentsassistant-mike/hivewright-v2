import type { Sql } from "postgres";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { buildSupervisorInitialPrompt, buildSprintWakeUpPrompt } from "./supervisor-session";
import { hiveGoalWorkspacePath } from "@/hives/workspace-root";
import { resolveGoalSupervisorRuntime } from "./supervisor-routing";
import { buildGoalSupervisorProcessEnv } from "./supervisor-env";
import { buildSupervisorToolsMd } from "./supervisor-tool-contract";

const OPENCLAW_BIN = ["/home/hivewright/.npm-global/bin/openclaw", "/usr/local/bin/openclaw", "openclaw"]
  .find(p => { try { fs.accessSync(p); return true; } catch { return false; } }) || "openclaw";

function buildOpenClawEnv(supervisorSession: string): NodeJS.ProcessEnv {
  return buildGoalSupervisorProcessEnv(
    {
      ...process.env,
      PATH: `/home/hivewright/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
    },
    supervisorSession,
  );
}

function runOpenClaw(
  args: string[],
  cwd: string,
  supervisorSession: string,
  timeout = 300_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(OPENCLAW_BIN, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      env: buildOpenClawEnv(supervisorSession),
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    proc.on("error", (err) => resolve({ stdout, stderr: err.message, code: 1 }));
  });
}

function extractJsonArray(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return null;
}

async function ensureSupervisorAgent(
  agentId: string,
  workspacePath: string,
  model: string,
  supervisorSession: string,
): Promise<{ ok: boolean; error?: string }> {
  const agentDir = path.join(process.env.HOME || "/home/hivewright", ".openclaw", "agents", agentId, "agent");
  if (fs.existsSync(agentDir)) {
    return { ok: true };
  }

  const listResult = await runOpenClaw(["agents", "list", "--json"], workspacePath, supervisorSession, 60_000);
  if (listResult.code === 0) {
    try {
      const jsonText = extractJsonArray(listResult.stdout);
      if (jsonText) {
        const agents = JSON.parse(jsonText) as Array<{ id?: string; name?: string }>;
        if (agents.some((a) => a.id === agentId || a.name === agentId)) {
          return { ok: true };
        }
      }
    } catch {
      // fall through to add attempt
    }
  }

  const addResult = await runOpenClaw(
    ["agents", "add", agentId, "--workspace", workspacePath, "--model", model, "--non-interactive"],
    workspacePath,
    supervisorSession,
    120_000,
  );
  if (addResult.code !== 0) {
    if (fs.existsSync(agentDir)) {
      return { ok: true };
    }
    return { ok: false, error: `agents add failed: ${addResult.stderr || addResult.stdout || listResult.stderr || listResult.stdout}` };
  }

  return { ok: true };
}

/**
 * Run a one-shot OpenClaw agent turn synchronously in the given workspace directory.
 * Timeout: 5 minutes, enough for a supervisor to make multiple API calls.
 */
function runSupervisorInWorkspace(
  agentId: string,
  workspacePath: string,
  prompt: string,
  supervisorSession: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return runOpenClaw(["agent", "--agent", agentId, "--message", prompt, "--json"], workspacePath, supervisorSession);
}

/**
 * Start a goal supervisor using a synchronous one-shot OpenClaw agent turn.
 *
 * Execution path:
 *   1. Write AGENTS.md + TOOLS.md to the goal workspace directory.
 *   2. Mark session_id immediately so the goal isn't re-triggered on the next lifecycle check.
 *   3. Run `openclaw agent --agent <agentId> --message <prompt> --json` from the workspace directory.
 *      OpenClaw reads AGENTS.md / TOOLS.md from the agent workspace, executes the supervisor, and blocks
 *      until complete (or 5-minute timeout). This is synchronous, no queuing.
 *   4. The supervisor creates sprint 1 tasks via the HiveWright HTTP API during its run.
 */
export async function startGoalSupervisor(
  sql: Sql,
  goalId: string,
): Promise<{ agentId: string; error?: string }> {
  // Get goal + hive info
  const [goal] = await sql`
    SELECT goals.id, goals.hive_id, goals.project_id, goals.title, projects.git_repo AS project_git_repo
    FROM goals
    LEFT JOIN projects ON projects.id = goals.project_id
    WHERE goals.id = ${goalId}
  `;
  if (!goal) return { agentId: "", error: "Goal not found" };

  const [biz] = await sql`SELECT slug, workspace_path FROM hives WHERE id = ${goal.hive_id}`;

  const runtime = await resolveGoalSupervisorRuntime(sql, goalId);
  const primaryModel = runtime.model;
  const bizSlug = biz?.slug as string || "default";

  const workspacePath = hiveGoalWorkspacePath(bizSlug, goalId);
  const supervisorSession = workspacePath;
  const agentId = `hw-gs-${bizSlug}-${goalId.slice(0, 8)}`;

  // Ensure workspace
  fs.mkdirSync(workspacePath, { recursive: true });

  // Build and write initial prompt
  const initialPrompt = await buildSupervisorInitialPrompt(sql, goalId);

  const agentsMd = `# Goal Supervisor

## Goal: ${goal.title}

${initialPrompt}

## Important
- You are a goal supervisor. Your job is to decompose this goal into sprints and tasks.
- Use the tools described below to create tasks, sub-goals, decisions, and schedules.
- After creating sprint tasks, wait for them to complete. You'll receive a wake-up with results.
`;

  const toolsMd = buildSupervisorToolsMd(goal as { hive_id: string; project_id?: string | null; project_git_repo?: boolean | null }, goalId);

  fs.writeFileSync(path.join(workspacePath, "AGENTS.md"), agentsMd, "utf-8");
  fs.writeFileSync(path.join(workspacePath, "TOOLS.md"), toolsMd, "utf-8");

  const ensured = await ensureSupervisorAgent(agentId, workspacePath, primaryModel, supervisorSession);
  if (!ensured.ok) {
    return { agentId, error: ensured.error || "Failed to provision supervisor agent" };
  }

  // Mark as started immediately — prevents re-triggering on the next lifecycle check
  await sql`UPDATE goals SET session_id = ${supervisorSession} WHERE id = ${goalId}`;

  // Run the supervisor synchronously — blocks until complete or timeout
  const runResult = await runSupervisorInWorkspace(agentId, workspacePath, initialPrompt, supervisorSession);

  if (runResult.code !== 0) {
    console.warn(`[supervisor] openclaw agent run failed for goal ${goalId} (exit ${runResult.code}): ${runResult.stderr}`);
    // Clear session_id so the next lifecycle check can retry — leaving it set
    // would permanently block the goal since findNewGoals filters on session_id IS NULL.
    await sql`UPDATE goals SET session_id = NULL WHERE id = ${goalId}`;
    return { agentId, error: `Supervisor run failed (exit ${runResult.code}): ${runResult.stderr.slice(0, 300)}` };
  }

  console.log(`[supervisor] Supervisor run complete for goal ${goalId}. Output: ${runResult.stdout.slice(0, 300)}`);
  return { agentId };
}

/**
 * Send a sprint wake-up to the supervisor by updating its context files and
 * running a synchronous one-shot OpenClaw agent turn.
 *
 * Execution path:
 *   1. Append sprint N results to AGENTS.md in the goal workspace.
 *   2. Run `openclaw agent --agent <agentId> --message <prompt> --json` from the workspace.
 *      The supervisor reads the updated AGENTS.md context, plans the next sprint, and
 *      creates sprint N+1 tasks via the HiveWright HTTP API.
 */
export async function wakeUpSupervisor(
  sql: Sql,
  goalId: string,
  sprintNumber: number,
): Promise<{ success: boolean; output: string; error?: string }> {
  const [goal] = await sql`
    SELECT goals.session_id, goals.hive_id, goals.project_id, projects.git_repo AS project_git_repo
    FROM goals
    LEFT JOIN projects ON projects.id = goals.project_id
    WHERE goals.id = ${goalId}
  `;
  if (!goal?.session_id) return { success: false, output: "", error: "No supervisor session" };

  const [biz] = await sql`SELECT slug FROM hives WHERE id = ${goal.hive_id}`;
  const bizSlug = biz?.slug as string || "default";
  const workspacePath = hiveGoalWorkspacePath(bizSlug, goalId);
  const supervisorSession = String(goal.session_id);

  const agentId = `hw-gs-${bizSlug}-${goalId.slice(0, 8)}`;

  // Build wake-up prompt and append to AGENTS.md
  const wakeUpPrompt = await buildSprintWakeUpPrompt(sql, goalId, sprintNumber);

  const existingAgents = fs.existsSync(path.join(workspacePath, "AGENTS.md"))
    ? fs.readFileSync(path.join(workspacePath, "AGENTS.md"), "utf-8")
    : "";

  // Truncate AGENTS.md to base context + last 3 sprint sections to prevent unbounded growth.
  const SECTION_SEPARATOR = "\n\n---\n\n## Sprint ";
  const agentsParts = existingAgents.split(SECTION_SEPARATOR);
  const agentsBase = agentsParts[0];
  const recentParts = agentsParts.slice(1).slice(-3);
  const trimmedAgents = recentParts.length > 0
    ? agentsBase + SECTION_SEPARATOR + recentParts.join(SECTION_SEPARATOR)
    : agentsBase;
  const updatedAgents =
    trimmedAgents +
    `\n\n---\n\n## Sprint ${sprintNumber} Results\n\n${wakeUpPrompt}\n\nPlan the next sprint based on these results. Create tasks using the API tools.`;

  fs.writeFileSync(path.join(workspacePath, "AGENTS.md"), updatedAgents, "utf-8");

  // Regenerate TOOLS.md so the supervisor always sees current endpoints (prevents drift)
  const toolsMd = buildSupervisorToolsMd(goal as { hive_id: string; project_id?: string | null; project_git_repo?: boolean | null }, goalId);
  fs.writeFileSync(path.join(workspacePath, "TOOLS.md"), toolsMd, "utf-8");

  // Run the supervisor synchronously — blocks until complete or timeout
  const runResult = await runSupervisorInWorkspace(agentId, workspacePath, wakeUpPrompt, supervisorSession);

  if (runResult.code !== 0) {
    return { success: false, output: runResult.stderr, error: `openclaw agent run failed (exit ${runResult.code}): ${runResult.stderr}` };
  }

  return { success: true, output: runResult.stdout };
}

/**
 * Terminate a goal supervisor by clearing its session from the DB.
 * The workspace directory is retained for inspection / compaction.
 */
export async function terminateGoalSupervisor(
  sql: Sql,
  goalId: string,
): Promise<void> {
  await sql`UPDATE goals SET session_id = NULL WHERE id = ${goalId}`;
}
