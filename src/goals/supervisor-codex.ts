import type { Sql } from "postgres";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { buildSupervisorInitialPrompt, buildSprintWakeUpPrompt, buildCommentWakeUpPrompt } from "./supervisor-session";
import { hiveGoalWorkspacePath } from "@/hives/workspace-root";
import { codexCliModelName, resolveGoalSupervisorRuntime } from "./supervisor-routing";
import { buildGoalSupervisorProcessEnv } from "./supervisor-env";
import { buildSupervisorToolsMd } from "./supervisor-tool-contract";

/**
 * codex-based goal-supervisor lifecycle. Mirrors supervisor-openclaw.ts so the
 * dispatcher can swap between them based on the goal-supervisor role's
 * adapter_type, without behavior change at the call sites.
 *
 * Uses codex's native session persistence:
 *   - `codex exec --json ...` (no --ephemeral) auto-persists the session to
 *     ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<UUID>.jsonl. The thread_id
 *     UUID is emitted in the first event of stdout (`thread.started`).
 *   - `codex exec resume <thread_id>` loads that session for a follow-up turn.
 *
 * We persist the thread_id in a `.codex-thread-id` file inside the goal
 * workspace (sibling to AGENTS.md/TOOLS.md) so wakeUpSupervisor can find it
 * without an extra DB column.
 */

const CODEX_BIN = ["/home/hivewright/.local/bin/codex", "/home/hivewright/.npm-global/bin/codex", "codex"]
  .find((p) => { try { fs.accessSync(p); return true; } catch { return false; } }) || "codex";

function buildCodexEnv(supervisorSession: string): NodeJS.ProcessEnv {
  const env = buildGoalSupervisorProcessEnv(process.env, supervisorSession);
  // Same hygiene as the codex adapter — strip OPENAI key so codex uses the
  // owner's ChatGPT OAuth instead of per-token API billing.
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  return env;
}

const THREAD_ID_FILE = ".codex-thread-id";

function runCodex(
  args: string[],
  cwd: string,
  prompt: string,
  supervisorSession: string,
  timeoutMs = 14_400_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(CODEX_BIN, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
      env: buildCodexEnv(supervisorSession),
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
    proc.on("error", (err) => resolve({ stdout, stderr: err.message, code: 1 }));
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

/** Pull the thread_id UUID out of the first `thread.started` event in JSONL stdout. */
function extractThreadId(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{"type":"thread.started"')) continue;
    try {
      const ev = JSON.parse(trimmed) as { thread_id?: string };
      if (typeof ev.thread_id === "string") return ev.thread_id;
    } catch { /* keep scanning */ }
  }
  return null;
}

export async function startGoalSupervisor(
  sql: Sql,
  goalId: string,
): Promise<{ agentId: string; error?: string }> {
  const [goal] = await sql`
    SELECT goals.id, goals.hive_id, goals.project_id, goals.title, projects.git_repo AS project_git_repo
    FROM goals
    LEFT JOIN projects ON projects.id = goals.project_id
    WHERE goals.id = ${goalId}
  `;
  if (!goal) return { agentId: "", error: "Goal not found" };

  const [biz] = await sql`SELECT slug, workspace_path FROM hives WHERE id = ${goal.hive_id}`;
  const runtime = await resolveGoalSupervisorRuntime(sql, goalId);
  const modelName = codexCliModelName(runtime.model);
  const bizSlug = (biz?.slug as string) || "default";

  const workspacePath = hiveGoalWorkspacePath(bizSlug, goalId);
  const supervisorSession = workspacePath;
  const agentId = `hw-gs-${bizSlug}-${goalId.slice(0, 8)}`;

  fs.mkdirSync(workspacePath, { recursive: true });

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

  // Mark started immediately so findNewGoals doesn't re-trigger this goal.
  await sql`UPDATE goals SET session_id = ${supervisorSession} WHERE id = ${goalId}`;

  const args = [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-m", modelName,
    "-C", workspacePath,
  ];

  const runResult = await runCodex(args, workspacePath, initialPrompt, supervisorSession);

  if (runResult.code !== 0) {
    console.warn(`[supervisor-codex] codex exec failed for goal ${goalId} (exit ${runResult.code}): ${runResult.stderr.slice(0, 500)}`);
    await sql`UPDATE goals SET session_id = NULL WHERE id = ${goalId}`;
    return { agentId, error: `Supervisor run failed (exit ${runResult.code}): ${runResult.stderr.slice(0, 300)}` };
  }

  const threadId = extractThreadId(runResult.stdout);
  if (threadId) {
    fs.writeFileSync(path.join(workspacePath, THREAD_ID_FILE), threadId, "utf-8");
  } else {
    console.warn(`[supervisor-codex] No thread.started event captured for goal ${goalId}; wake-ups will fall back to a fresh session.`);
  }

  console.log(`[supervisor-codex] Supervisor run complete for goal ${goalId}; thread_id=${threadId ?? "(not captured)"}`);
  return { agentId };
}

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
  const runtime = await resolveGoalSupervisorRuntime(sql, goalId);
  const modelName = codexCliModelName(runtime.model);
  const bizSlug = (biz?.slug as string) || "default";
  const workspacePath = hiveGoalWorkspacePath(bizSlug, goalId);
  const supervisorSession = String(goal.session_id);

  // Refresh TOOLS.md so the supervisor sees current endpoints (prevents drift).
  const toolsMd = buildSupervisorToolsMd(goal as { hive_id: string; project_id?: string | null; project_git_repo?: boolean | null }, goalId);
  fs.writeFileSync(path.join(workspacePath, "TOOLS.md"), toolsMd, "utf-8");

  const wakeUpPrompt = await buildSprintWakeUpPrompt(sql, goalId, sprintNumber);

  const threadIdPath = path.join(workspacePath, THREAD_ID_FILE);
  const threadId = fs.existsSync(threadIdPath) ? fs.readFileSync(threadIdPath, "utf-8").trim() : null;

  // `codex exec resume` quirks:
  //  - `-C <workspace>` isn't accepted — resumed sessions keep their
  //    original cwd from rollout metadata. Only valid on a fresh `exec`.
  //  - `-` must be passed as the PROMPT positional to signal stdin read.
  //  - `-m <model>` is NOT passed on resume: if the session was created
  //    with a different model (e.g. original openai-codex vs. a later
  //    recommended_model switch to anthropic/claude-opus-4-7), codex
  //    silently exits with last_agent_message=null instead of either
  //    switching or erroring cleanly. Letting the session keep its
  //    original model is the safe path; model upgrades happen when the
  //    session is recreated from scratch.
  const freshFlags = [
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-m", modelName,
    "-C", workspacePath,
  ];
  const resumeFlags = [
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
  ];
  const args = threadId
    ? ["exec", "resume", threadId, ...resumeFlags, "-"]
    : ["exec", ...freshFlags];

  const runResult = await runCodex(args, workspacePath, wakeUpPrompt, supervisorSession);

  if (runResult.code !== 0) {
    return { success: false, output: runResult.stderr, error: `codex exec failed (exit ${runResult.code}): ${runResult.stderr.slice(0, 500)}` };
  }

  // Capture a fresh thread_id when we did NOT resume — every fresh exec starts a new thread.
  if (!threadId) {
    const newId = extractThreadId(runResult.stdout);
    if (newId) fs.writeFileSync(threadIdPath, newId, "utf-8");
  }

  return { success: true, output: runResult.stdout };
}

/**
 * Wake the supervisor in response to a new goal-comment. Mirrors
 * `wakeUpSupervisor` but uses `buildCommentWakeUpPrompt` so the
 * supervisor interprets owner input against current goal state rather
 * than sprint results. Same thread-resume pathway — preserves
 * conversational continuity across sprints + comments.
 */
export async function wakeUpSupervisorOnComment(
  sql: Sql,
  goalId: string,
  commentId: string,
): Promise<{ success: boolean; output: string; error?: string }> {
  const [goal] = await sql`
    SELECT goals.session_id, goals.hive_id, goals.project_id, projects.git_repo AS project_git_repo
    FROM goals
    LEFT JOIN projects ON projects.id = goals.project_id
    WHERE goals.id = ${goalId}
  `;
  if (!goal?.session_id) return { success: false, output: "", error: "No supervisor session" };

  const [biz] = await sql`SELECT slug FROM hives WHERE id = ${goal.hive_id}`;
  const runtime = await resolveGoalSupervisorRuntime(sql, goalId);
  const modelName = codexCliModelName(runtime.model);
  const bizSlug = (biz?.slug as string) || "default";
  const workspacePath = hiveGoalWorkspacePath(bizSlug, goalId);
  const supervisorSession = String(goal.session_id);

  // Refresh TOOLS.md so the comment wake sees current endpoints too.
  const toolsMd = buildSupervisorToolsMd(goal as { hive_id: string; project_id?: string | null; project_git_repo?: boolean | null }, goalId);
  fs.writeFileSync(path.join(workspacePath, "TOOLS.md"), toolsMd, "utf-8");

  const wakeUpPrompt = await buildCommentWakeUpPrompt(sql, goalId, commentId);

  const threadIdPath = path.join(workspacePath, THREAD_ID_FILE);
  const threadId = fs.existsSync(threadIdPath) ? fs.readFileSync(threadIdPath, "utf-8").trim() : null;

  // `-C` is only valid on a fresh `codex exec`; `codex exec resume` rejects it
  // with "unexpected argument '-C'" because the resumed session already has
  // its cwd captured in the rollout metadata.
  const commonFlags = [
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-m", modelName,
  ];
  // `codex exec resume` needs `-` as the explicit PROMPT positional to read
  // from stdin — the help says "If `-` is used, read from stdin". Without
  // it, codex emits "Reading prompt from stdin..." and then exits 1 when the
  // positional PROMPT is absent.
  const args = threadId
    ? ["exec", "resume", threadId, ...commonFlags, "-"]
    : ["exec", ...commonFlags, "-C", workspacePath];

  const runResult = await runCodex(args, workspacePath, wakeUpPrompt, supervisorSession);

  if (runResult.code !== 0) {
    return { success: false, output: runResult.stderr, error: `codex exec failed (exit ${runResult.code}): ${runResult.stderr.slice(0, 500)}` };
  }

  if (!threadId) {
    const newId = extractThreadId(runResult.stdout);
    if (newId) fs.writeFileSync(threadIdPath, newId, "utf-8");
  }

  return { success: true, output: runResult.stdout };
}

export async function terminateGoalSupervisor(
  sql: Sql,
  goalId: string,
): Promise<void> {
  // codex sessions don't need explicit teardown — they auto-expire from the
  // sessions/ directory. We just clear the DB pointer so the goal can re-spawn.
  await sql`UPDATE goals SET session_id = NULL WHERE id = ${goalId}`;
}
