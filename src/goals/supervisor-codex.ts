import type { Sql } from "postgres";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { buildSupervisorInitialPrompt, buildSprintWakeUpPrompt, buildCommentWakeUpPrompt } from "./supervisor-session";
import { hiveGoalWorkspacePath } from "@/hives/workspace-root";
import { codexCliModelName, resolveGoalSupervisorRuntime } from "./supervisor-routing";

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

const CODEX_BIN = [
  process.env.CODEX_BIN,
  process.env.HOME ? path.join(process.env.HOME, ".local/bin/codex") : undefined,
  process.env.HOME ? path.join(process.env.HOME, ".npm-global/bin/codex") : undefined,
  "codex",
].filter((p): p is string => Boolean(p))
  .find((p) => { try { fs.accessSync(p); return true; } catch { return false; } }) || "codex";

const CODEX_ENV: NodeJS.ProcessEnv = (() => {
  const env: Record<string, string | undefined> = { ...process.env };
  // Same hygiene as the codex adapter — strip OPENAI key so codex uses the
  // owner's ChatGPT OAuth instead of per-token API billing.
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  return env as NodeJS.ProcessEnv;
})();

const THREAD_ID_FILE = ".codex-thread-id";

function runCodex(args: string[], cwd: string, prompt: string, timeoutMs = 14_400_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(CODEX_BIN, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
      env: CODEX_ENV,
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

function buildToolsMd(
  goal: { hive_id: string; project_id?: string | null },
  goalId: string,
): string {
  const projectIdField = goal.project_id ? `, "projectId": "${goal.project_id}"` : "";
  return `# Supervisor Tools

You manage this goal by executing \`curl\` commands against HiveWright's local HTTP API at http://localhost:3002. The shell is available to you — run these commands directly; do not ask for tools to be exposed. Always send \`-H 'Content-Type: application/json'\` on POST/PUT. Parse responses with \`jq\` if you need to chain IDs.
Every local API request must include \`-H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN'\`. Every write request must also include \`-H 'X-HiveWright-Task-Id: $HIVEWRIGHT_TASK_ID'\`. Do not bypass the API with direct DB inserts or local markdown-only planning files.

## Create Task
\`\`\`bash
IDEMPOTENCY_KEY=$(node -e 'console.log(require("crypto").randomUUID())')
curl -sS -X POST http://localhost:3002/api/tasks \\
  -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN' \\
  -H 'X-HiveWright-Task-Id: $HIVEWRIGHT_TASK_ID' \\
  -H 'Content-Type: application/json' \\
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \\
  -d '{"hiveId":"${goal.hive_id}","assignedTo":"<role-slug>","title":"...","brief":"...","goalId":"${goalId}","sprintNumber":<n>,"qaRequired":true,"createdBy":"goal-supervisor"${projectIdField}}'
\`\`\`

**Critical — how QA works:** set \`"qaRequired":true\` on the *work* task and the dispatcher automatically spawns a QA review task as its child AFTER the work task finishes, passing in the deliverable. **Never create a task assigned to \`qa\` yourself** — it would run in parallel with the work task and review nothing. Always assign to an executor role (e.g. \`dev-agent\`, \`designer\`, \`content-writer\`, \`bookkeeper\`). If in doubt about which role to use, \`curl\` /api/roles first.
When creating replacement work for a failed or cancelled task, include \`"sourceTaskId":"<failed-or-cancelled-task-uuid>"\` in the task body. This links recovery work to the source task and enforces the recovery budget.
${goal.project_id ? `\nIMPORTANT: This goal is associated with project ${goal.project_id}. Always include \`"projectId":"${goal.project_id}"\` in every task body so code tasks run in the correct repository.\n` : ""}
## Create Sub-Goal
\`\`\`bash
IDEMPOTENCY_KEY=$(node -e 'console.log(require("crypto").randomUUID())')
curl -sS -X POST http://localhost:3002/api/goals \\
  -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN' \\
  -H 'X-HiveWright-Task-Id: $HIVEWRIGHT_TASK_ID' \\
  -H 'Content-Type: application/json' \\
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \\
  -d '{"hiveId":"${goal.hive_id}","title":"...","description":"...","parentId":"${goalId}"}'
\`\`\`

## Create / Update Goal Plan
\`\`\`bash
curl -sS -X PUT http://localhost:3002/api/goals/${goalId}/documents/plan \\
  -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN' \\
  -H 'X-HiveWright-Task-Id: $HIVEWRIGHT_TASK_ID' \\
  -H 'Content-Type: application/json' \\
  -d '{"title":"<plan title>","body":"<full markdown plan body>"}'
\`\`\`

## Create Decision
\`\`\`bash
curl -sS -X POST http://localhost:3002/api/decisions \\
  -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN' \\
  -H 'X-HiveWright-Task-Id: $HIVEWRIGHT_TASK_ID' \\
  -H 'Content-Type: application/json' \\
  -d '{"hiveId":"${goal.hive_id}","goalId":"${goalId}","title":"...","context":"...","recommendation":"...","options":[...],"priority":"normal","autoApprove":false}'
\`\`\`

## Create Schedule
\`\`\`bash
curl -sS -X POST http://localhost:3002/api/schedules \\
  -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN' \\
  -H 'X-HiveWright-Task-Id: $HIVEWRIGHT_TASK_ID' \\
  -H 'Content-Type: application/json' \\
  -d '{"hiveId":"${goal.hive_id}","cronExpression":"<cron>","taskTemplate":{"assignedTo":"<role>","title":"...","brief":"..."}}'
\`\`\`

## Mark Goal Achieved
\`\`\`bash
curl -sS -X POST http://localhost:3002/api/goals/${goalId}/complete \\
  -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN' \\
  -H 'X-HiveWright-Task-Id: $HIVEWRIGHT_TASK_ID' \\
  -H 'Content-Type: application/json' \\
  -d '{"summary":"<one-paragraph achievement summary>","evidenceTaskIds":["<uuid>"],"evidenceWorkProductIds":["<uuid>"]}'
\`\`\`

## Query Memory
\`\`\`bash
curl -sS "http://localhost:3002/api/memory/search?hiveId=${goal.hive_id}&q=<search>" \\
  -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN'
\`\`\`

## Available Roles
\`\`\`bash
curl -sS http://localhost:3002/api/roles \\
  -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN'
\`\`\`

## Expected workflow for this run
1. \`curl\` /api/roles to see available role slugs. Never assign a task to \`qa\` yourself — QA is spawned by the dispatcher when a work task with \`"qaRequired":true\` completes.
2. PUT /api/goals/${goalId}/documents/plan with your markdown plan.
3. POST /api/tasks one per concrete unit of work, assigned to the appropriate executor role. Each gets a sprintNumber starting at 1. Include \`"qaRequired":true\` unless the task is trivially verifiable — dispatcher will auto-create the QA review task after completion.
4. Return a brief human-readable summary of what you planned and the task IDs created.
`;
}

export async function startGoalSupervisor(
  sql: Sql,
  goalId: string,
): Promise<{ agentId: string; error?: string }> {
  const [goal] = await sql`SELECT id, hive_id, project_id, title FROM goals WHERE id = ${goalId}`;
  if (!goal) return { agentId: "", error: "Goal not found" };

  const [biz] = await sql`SELECT slug, workspace_path FROM hives WHERE id = ${goal.hive_id}`;
  const runtime = await resolveGoalSupervisorRuntime(sql, goalId);
  const modelName = codexCliModelName(runtime.model);
  const bizSlug = (biz?.slug as string) || "default";

  const workspacePath = hiveGoalWorkspacePath(bizSlug, goalId);
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
  const toolsMd = buildToolsMd(goal as { hive_id: string; project_id?: string | null }, goalId);
  fs.writeFileSync(path.join(workspacePath, "AGENTS.md"), agentsMd, "utf-8");
  fs.writeFileSync(path.join(workspacePath, "TOOLS.md"), toolsMd, "utf-8");

  // Mark started immediately so findNewGoals doesn't re-trigger this goal.
  await sql`UPDATE goals SET session_id = ${workspacePath} WHERE id = ${goalId}`;

  const args = [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-m", modelName,
    "-C", workspacePath,
  ];

  const runResult = await runCodex(args, workspacePath, initialPrompt);

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
  const [goal] = await sql`SELECT session_id, hive_id, project_id FROM goals WHERE id = ${goalId}`;
  if (!goal?.session_id) return { success: false, output: "", error: "No supervisor session" };

  const [biz] = await sql`SELECT slug FROM hives WHERE id = ${goal.hive_id}`;
  const runtime = await resolveGoalSupervisorRuntime(sql, goalId);
  const modelName = codexCliModelName(runtime.model);
  const bizSlug = (biz?.slug as string) || "default";
  const workspacePath = hiveGoalWorkspacePath(bizSlug, goalId);

  // Refresh TOOLS.md so the supervisor sees current endpoints (prevents drift).
  const toolsMd = buildToolsMd(goal as { hive_id: string; project_id?: string | null }, goalId);
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

  const runResult = await runCodex(args, workspacePath, wakeUpPrompt);

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
  const [goal] = await sql`SELECT session_id, hive_id, project_id FROM goals WHERE id = ${goalId}`;
  if (!goal?.session_id) return { success: false, output: "", error: "No supervisor session" };

  const [biz] = await sql`SELECT slug FROM hives WHERE id = ${goal.hive_id}`;
  const runtime = await resolveGoalSupervisorRuntime(sql, goalId);
  const modelName = codexCliModelName(runtime.model);
  const bizSlug = (biz?.slug as string) || "default";
  const workspacePath = hiveGoalWorkspacePath(bizSlug, goalId);

  // Refresh TOOLS.md so the comment wake sees current endpoints too.
  const toolsMd = buildToolsMd(goal as { hive_id: string; project_id?: string | null }, goalId);
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

  const runResult = await runCodex(args, workspacePath, wakeUpPrompt);

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
