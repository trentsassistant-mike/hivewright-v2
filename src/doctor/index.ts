import type { Sql } from "postgres";
import { readLatestCodexEmptyOutputDiagnostic } from "@/runtime-diagnostics/codex-empty-output";
import { inheritTaskWorkspaceFromParent } from "@/dispatcher/worktree-manager";
import { findExistingDoctorRecoveryTask } from "@/dispatcher/recovery-loop-guard";
import { parkTaskIfRecoveryBudgetExceeded } from "@/recovery/recovery-budget";
import type { DoctorDiagnosis, ParseDoctorDiagnosisResult } from "./types";

export { escalateMalformedDiagnosis } from "./escalate";

// Case-insensitive on the `json` language tag — some LLMs emit ```JSON or ```Json.
const FENCED_JSON_RE = /```json\s*\n([\s\S]*?)\n\s*```/gi;
const VALID_ACTIONS: ReadonlySet<DoctorDiagnosis["action"]> = new Set([
  "rewrite_brief",
  "reassign",
  "split_task",
  "fix_environment",
  "escalate",
  "reclassify",
  "convert-to-goal",
]);

export function parseDoctorDiagnosis(output: string): ParseDoctorDiagnosisResult {
  // Collect all fenced json blocks — the doctor may "think out loud" and
  // emit multiple drafts; the LAST one is the final answer.
  const matches = [...output.matchAll(FENCED_JSON_RE)];
  if (matches.length === 0) {
    return { ok: false, kind: "no_block", reason: "No ```json block found in doctor output." };
  }
  const raw = matches[matches.length - 1][1];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      kind: "malformed",
      reason: `Doctor diagnosis JSON malformed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, kind: "malformed", reason: "Doctor diagnosis JSON malformed: not an object." };
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.action !== "string") {
    return { ok: false, kind: "malformed", reason: "Doctor diagnosis missing string 'action' field." };
  }
  if (!VALID_ACTIONS.has(obj.action as DoctorDiagnosis["action"])) {
    return { ok: false, kind: "malformed", reason: `Unknown action: ${obj.action}` };
  }
  if (typeof obj.details !== "string" || obj.details.trim() === "") {
    return { ok: false, kind: "malformed", reason: "Doctor diagnosis missing 'details' field." };
  }

  const action = obj.action as DoctorDiagnosis["action"];

  // Action-specific required fields.
  if (action === "rewrite_brief" && (typeof obj.newBrief !== "string" || obj.newBrief.trim() === "")) {
    return { ok: false, kind: "malformed", reason: "rewrite_brief requires 'newBrief'." };
  }
  if (action === "reassign" && (typeof obj.newRole !== "string" || obj.newRole.trim() === "")) {
    return { ok: false, kind: "malformed", reason: "reassign requires 'newRole'." };
  }
  if (action === "split_task") {
    if (!Array.isArray(obj.subTasks) || obj.subTasks.length === 0) {
      return { ok: false, kind: "malformed", reason: "split_task requires non-empty 'subTasks' array." };
    }
    for (const s of obj.subTasks) {
      if (!s || typeof s !== "object") {
        return { ok: false, kind: "malformed", reason: "split_task subTasks entries must be objects." };
      }
      const sub = s as Record<string, unknown>;
      if (typeof sub.title !== "string" || typeof sub.brief !== "string" || typeof sub.assignedTo !== "string") {
        return { ok: false, kind: "malformed", reason: "split_task subTasks entries require string title, brief, assignedTo." };
      }
    }
  }

  // Optional fields must be strings when present — we cast to DoctorDiagnosis
  // below, and applyDoctorDiagnosis threads decisionTitle/Context into SQL.
  if (obj.decisionTitle !== undefined && typeof obj.decisionTitle !== "string") {
    return { ok: false, kind: "malformed", reason: "decisionTitle must be a string if provided." };
  }
  if (obj.decisionContext !== undefined && typeof obj.decisionContext !== "string") {
    return { ok: false, kind: "malformed", reason: "decisionContext must be a string if provided." };
  }

  return { ok: true, diagnosis: obj as unknown as DoctorDiagnosis };
}

export async function applyDoctorDiagnosis(
  sql: Sql,
  taskId: string,
  diagnosis: DoctorDiagnosis,
): Promise<void> {
  switch (diagnosis.action) {
    case "rewrite_brief": {
      await sql`
        UPDATE tasks
        SET status = 'pending', brief = ${diagnosis.newBrief!},
            doctor_attempts = doctor_attempts + 1, retry_count = 0,
            retry_after = NULL, updated_at = NOW()
        WHERE id = ${taskId}
      `;
      break;
    }
    case "reassign": {
      await sql`
        UPDATE tasks
        SET status = 'pending', assigned_to = ${diagnosis.newRole!},
            doctor_attempts = doctor_attempts + 1, retry_count = 0,
            retry_after = NULL, updated_at = NOW()
        WHERE id = ${taskId}
      `;
      break;
    }
    case "split_task": {
      const [original] = await sql`
        SELECT hive_id, goal_id, sprint_number, project_id FROM tasks WHERE id = ${taskId}
      `;

      // Validate every subtask's role slug + the no-direct-qa rule BEFORE
      // we cancel the parent. Doing this up-front means a half-applied
      // split (parent cancelled + only some subtasks inserted) can no
      // longer happen — a known failure mode where the doctor produced
      // `qa-agent` (FK violation) and the dispatcher had to escalate
      // after the parent was already destroyed.
      const subRoles = (diagnosis.subTasks ?? []).map((s) => s.assignedTo);
      const knownRoles = await sql<{ slug: string }[]>`
        SELECT slug FROM role_templates WHERE slug IN ${sql(subRoles.length > 0 ? subRoles : [""])}
      `;
      const knownSet = new Set(knownRoles.map((r) => r.slug));
      const unknownRoles = subRoles.filter((r) => !knownSet.has(r));
      if (unknownRoles.length > 0) {
        throw new Error(
          `split_task references unknown role slug(s): ${unknownRoles.join(", ")}. ` +
          `Valid slugs: ${[...knownSet].join(", ") || "(none)"}. ` +
          `Note: QA tasks should NOT be assigned directly — set qaRequired=true ` +
          `on the work task and the dispatcher spawns a QA review automatically.`
        );
      }
      const directQa = subRoles.filter((r) => r === "qa");
      if (directQa.length > 0) {
        throw new Error(
          `split_task cannot assign tasks directly to "qa" — that bypasses the ` +
          `automatic QA-after-work pipeline. Assign the work to an executor role ` +
          `(e.g. dev-agent) and rely on qaRequired=true on the work task instead.`
        );
      }

      const budgetDecision = await parkTaskIfRecoveryBudgetExceeded(sql, taskId, {
        action: "doctor split_task",
        reason: diagnosis.details,
        replacementTasksToCreate: diagnosis.subTasks!.length,
      });
      if (!budgetDecision.ok) break;

      await sql`
        UPDATE tasks SET status = 'cancelled', updated_at = NOW() WHERE id = ${taskId}
      `;
      for (const sub of diagnosis.subTasks!) {
        const [subTask] = await sql`
          INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, parent_task_id, goal_id, sprint_number, project_id)
          VALUES (${original.hive_id}, ${sub.assignedTo}, 'doctor', ${sub.title}, ${sub.brief}, ${taskId}, ${original.goal_id}, ${original.sprint_number}, ${original.project_id})
          RETURNING id
        `;
        await inheritTaskWorkspaceFromParent(sql, taskId, subTask.id as string);
      }
      break;
    }
    case "fix_environment": {
      const budgetDecision = await parkTaskIfRecoveryBudgetExceeded(sql, taskId, {
        action: "doctor fix_environment",
        reason: diagnosis.details,
        doctorTasksToCreate: 1,
      });
      if (!budgetDecision.ok) break;

      const [original] = await sql`
        SELECT hive_id, project_id FROM tasks WHERE id = ${taskId}
      `;
      const [envFixTask] = await sql`
        INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, project_id)
        VALUES (${original.hive_id}, 'doctor', 'doctor',
          ${"Fix environment for: " + taskId},
          ${diagnosis.details},
          ${original.project_id})
        RETURNING id
      `;
      await inheritTaskWorkspaceFromParent(sql, taskId, envFixTask.id as string);
      await sql`
        UPDATE tasks
        SET status = 'blocked', doctor_attempts = doctor_attempts + 1, updated_at = NOW()
        WHERE id = ${taskId}
      `;
      break;
    }
    case "escalate": {
      const budgetDecision = await parkTaskIfRecoveryBudgetExceeded(sql, taskId, {
        action: "doctor escalate",
        reason: diagnosis.details,
        recoveryDecisionsToCreate: 1,
      });
      if (!budgetDecision.ok) break;

      const [task] = await sql`
        SELECT hive_id, goal_id FROM tasks WHERE id = ${taskId}
      `;
      await sql`
        UPDATE tasks SET status = 'unresolvable', updated_at = NOW() WHERE id = ${taskId}
      `;
      const decisionTitle = diagnosis.decisionTitle || "Task requires owner input";
      const decisionContext = diagnosis.decisionContext || diagnosis.details;
      // Route through EA-first: owner is a USER, not a developer; the EA
      // attempts autonomous resolution and only escalates with rewritten
      // plain-English context if it genuinely needs the owner's
      // judgement. The notification is fired by the EA pipeline after
      // (and only if) it escalates.
      await sql`
        INSERT INTO decisions (hive_id, goal_id, title, context, priority, status)
        VALUES (
          ${task.hive_id},
          ${task.goal_id},
          ${decisionTitle},
          ${decisionContext},
          'urgent',
          'ea_review'
        )
      `;
      break;
    }
    case "reclassify": {
      const { applyReclassify } = await import("./reclassify");
      await applyReclassify(sql, taskId, diagnosis.failureContext ?? diagnosis.details);
      break;
    }
    case "convert-to-goal": {
      const { applyConvertToGoal } = await import("./reclassify");
      await applyConvertToGoal(sql, taskId);
      break;
    }
  }
}

export async function createDoctorTask(sql: Sql, failedTaskId: string) {
  const existingDoctorTask = await findExistingDoctorRecoveryTask(sql, failedTaskId);
  if (existingDoctorTask) return existingDoctorTask;

  const [task] = await sql`
    SELECT id, hive_id, title, brief, assigned_to, failure_reason, acceptance_criteria, project_id
    FROM tasks WHERE id = ${failedTaskId}
  `;
  if (!task) return null;

  // Inject the live list of valid role slugs into the brief — the doctor
  // is a pure-LLM ollama agent with no shell access, so it cannot query
  // /api/roles itself. Without this it routinely emits invented slugs
  // like "qa-agent" or "developer" which fail the role_templates FK.
  const validRoles = await sql<{ slug: string; type: string }[]>`
    SELECT slug, type FROM role_templates WHERE active = true ORDER BY type, slug
  `;
  const executorSlugs = validRoles.filter((r) => r.type === "executor").map((r) => r.slug);
  const systemSlugs = validRoles.filter((r) => r.type === "system").map((r) => r.slug);
  const codexEmptyOutputDiagnostic = await readLatestCodexEmptyOutputDiagnostic(sql, failedTaskId);
  const runtimeDiagnosticsSection = codexEmptyOutputDiagnostic
    ? [
        "### Runtime Diagnostics",
        "- codexEmptyOutput: true",
        `- rolloutSignaturePresent: ${codexEmptyOutputDiagnostic.rolloutSignaturePresent}`,
        `- exitCode: ${codexEmptyOutputDiagnostic.exitCode ?? "unknown"}`,
        `- effectiveAdapter: ${codexEmptyOutputDiagnostic.effectiveAdapter || "unknown"}`,
        `- adapterOverride: ${codexEmptyOutputDiagnostic.adapterOverride || "none"}`,
        `- modelSlug: ${codexEmptyOutputDiagnostic.modelSlug || "unknown"}`,
        `- modelProviderMismatchDetected: ${codexEmptyOutputDiagnostic.modelProviderMismatchDetected}`,
        `- cwd: ${codexEmptyOutputDiagnostic.cwd || "unknown"}`,
        "- stderrTail:",
        "```text",
        codexEmptyOutputDiagnostic.stderrTail,
        "```",
        "",
      ].join("\n")
    : "";

  const doctorBrief = [
    "## Failed Task Diagnosis",
    "",
    `**Original Task:** ${task.title}`,
    `**Assigned To:** ${task.assigned_to}`,
    `**Failure Reason:** ${task.failure_reason || "Unknown"}`,
    "",
    "### Original Brief",
    task.brief,
    "",
    task.acceptance_criteria ? `### Acceptance Criteria\n${task.acceptance_criteria}` : "",
    "",
    runtimeDiagnosticsSection,
    "### Valid role slugs you can assign work to",
    "Executors (assignedTo / newRole MUST be one of these strings exactly):",
    executorSlugs.map((s) => `  - ${s}`).join("\n"),
    "",
    "System roles (do not assign to these in subTasks):",
    systemSlugs.map((s) => `  - ${s}`).join("\n"),
    "",
    "**QA pipeline rule:** Never create a task assigned to `qa` in `split_task`.",
    "QA review is spawned automatically by the dispatcher after a work task with",
    "`qaRequired=true` completes. If you split work, assign each subtask to an",
    "executor role; the QA review will follow automatically. Pre-spawning a `qa`",
    "task here will be rejected by the dispatcher and forces a Tier 3 escalation.",
    "",
    "### Your Job",
    "Diagnose why this task failed and choose one action:",
    "1. Rewrite the brief (if ambiguous or missing info)",
    "2. Reassign to a different role (if wrong agent type)",
    "3. Split into subtasks (if too complex)",
    "4. Create an environment fix task (if dependency/API issue)",
    "5. Reclassify (if the executor said \"this isn't my job\")",
    "6. Convert to goal (if it needs decomposition)",
    "7. Escalate to owner (last resort — create a Tier 3 decision)",
  ].join("\n");

  const [doctorTask] = await sql`
    INSERT INTO tasks (hive_id, assigned_to, created_by, title, brief, parent_task_id, priority, project_id)
    VALUES (
      ${task.hive_id},
      'doctor',
      'dispatcher',
      ${`[Doctor] Diagnose: ${task.title}`},
      ${doctorBrief},
      ${failedTaskId},
      1,
      ${task.project_id}
    )
    RETURNING *
  `;

  await inheritTaskWorkspaceFromParent(sql, failedTaskId, doctorTask.id as string);

  return doctorTask;
}
