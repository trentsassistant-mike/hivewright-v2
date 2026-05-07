import type { Sql } from "postgres";
import type { DecisionOption } from "@/db/schema/decisions";
import { applicableQualityFloor, loadQualityControlsConfig } from "./quality-config";
import { calculateRoleQualityScoreForTaskIds } from "./score";
import { createOrUpdateSkillCandidateFromSignal } from "@/skills/self-creation";

export const QUALITY_DOCTOR_MODEL = "auto";
export const QUALITY_DOCTOR_DECISION_KIND = "quality_doctor_recommendation";

export type QualityDoctorCause =
  | "wrong_model"
  | "missing_skill"
  | "missing_tool_connector_credential"
  | "wrong_role_or_brief";

export interface QualityDoctorDiagnosis {
  cause: QualityDoctorCause;
  details: string;
  recommendation: string;
  options?: DecisionOption[];
}

const VALID_CAUSES: ReadonlySet<QualityDoctorCause> = new Set([
  "wrong_model",
  "missing_skill",
  "missing_tool_connector_credential",
  "wrong_role_or_brief",
]);

export function parseQualityDoctorDiagnosis(output: string): QualityDoctorDiagnosis | null {
  const matches = [...output.matchAll(/```json\s*\n([\s\S]*?)\n\s*```/gi)];
  if (matches.length === 0) return null;
  const raw = matches[matches.length - 1][1];
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!VALID_CAUSES.has(parsed.cause as QualityDoctorCause)) return null;
    if (typeof parsed.details !== "string" || parsed.details.trim() === "") return null;
    if (typeof parsed.recommendation !== "string" || parsed.recommendation.trim() === "") return null;
    const options = parsed.options === undefined ? undefined : parseDecisionOptions(parsed.options);
    if (parsed.options !== undefined && !options) return null;
    return {
      cause: parsed.cause as QualityDoctorCause,
      details: parsed.details,
      recommendation: parsed.recommendation,
      options: options ?? undefined,
    };
  } catch {
    return null;
  }
}

export async function maybeCreateQualityDoctorForSignal(
  sql: Sql,
  taskId: string,
  evidence: {
    source: "explicit_owner_feedback" | "explicit_ai_peer_feedback" | "implicit_ea";
    signalType: "positive" | "negative" | "neutral";
    rating?: number | null;
    evidence: string;
    confidence: number;
  },
): Promise<string | null> {
  const lowExplicit = (evidence.source === "explicit_owner_feedback" ||
    evidence.source === "explicit_ai_peer_feedback")
    && typeof evidence.rating === "number"
    && evidence.rating <= 6;
  const strongNegativeImplicit = evidence.source === "implicit_ea"
    && evidence.signalType === "negative"
    && evidence.confidence >= 0.8;
  if (!lowExplicit && !strongNegativeImplicit) return null;

  return createQualityDoctorTask(sql, taskId, evidence);
}

export async function maybeCreateQualityDoctorForRoleWindow(
  sql: Sql,
  hiveId: string,
  roleSlug: string,
): Promise<string | null> {
  const config = await loadQualityControlsConfig(sql, hiveId);
  const floor = applicableQualityFloor(config, roleSlug);

  const latestTasks = await sql<{ id: string }[]>`
    SELECT id
    FROM tasks
    WHERE hive_id = ${hiveId}::uuid
      AND assigned_to = ${roleSlug}
      AND status = 'completed'
    ORDER BY COALESCE(completed_at, updated_at, created_at) DESC
    LIMIT 5
  `;
  if (latestTasks.length < 5) return null;

  const taskIds = latestTasks.map((task) => task.id);
  const score = await calculateRoleQualityScoreForTaskIds(sql, hiveId, roleSlug, taskIds);
  if (score.sample.completedTasks < 5 || score.qualityScore >= floor - 0.1) return null;

  return createQualityDoctorTask(sql, latestTasks[0].id, {
    source: "implicit_ea",
    signalType: "negative",
    evidence: `Composite role quality ${score.qualityScore.toFixed(3)} is more than 0.1 below floor ${floor.toFixed(2)} in the latest 5 completed task window.`,
    confidence: 1,
  });
}

export async function createQualityDoctorTask(
  sql: Sql,
  taskId: string,
  evidence: {
    source: string;
    signalType: string;
    rating?: number | null;
    evidence: string;
    confidence: number;
  },
): Promise<string | null> {
  const [task] = await sql<{
    id: string;
    hive_id: string;
    goal_id: string | null;
    assigned_to: string;
    title: string;
    brief: string;
    result_summary: string | null;
  }[]>`
    SELECT id, hive_id, goal_id, assigned_to, title, brief, result_summary
    FROM tasks
    WHERE id = ${taskId}
  `;
  if (!task) return null;

  const [workProduct] = await sql<{ summary: string | null; content: string | null }[]>`
    SELECT summary, content
    FROM work_products
    WHERE task_id = ${taskId}
      AND hive_id = ${task.hive_id}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const logs = await sql<{ chunk: string; type: string }[]>`
    SELECT type, chunk
    FROM task_logs
    WHERE task_id = ${taskId}
    ORDER BY id DESC
    LIMIT 20
  `;
  const [existing] = await sql<{ id: string }[]>`
    SELECT id
    FROM tasks
    WHERE parent_task_id = ${taskId}
      AND assigned_to = 'doctor'
      AND created_by = 'quality-doctor'
      AND title = ${`Quality diagnosis: ${task.title}`}
    LIMIT 1
  `;
  if (existing) return existing.id;

  const brief = buildQualityDoctorBrief(task, evidence, workProduct, logs.reverse());
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO tasks (
      hive_id, goal_id, assigned_to, created_by, title, brief,
      parent_task_id, priority, model_override
    )
    VALUES (
      ${task.hive_id}, ${task.goal_id}, 'doctor', 'quality-doctor',
      ${`Quality diagnosis: ${task.title}`}, ${brief},
      ${taskId}, 4, ${QUALITY_DOCTOR_MODEL}
    )
    RETURNING id
  `;
  return row.id;
}

export async function applyQualityDoctorDiagnosis(
  sql: Sql,
  taskId: string,
  diagnosis: QualityDoctorDiagnosis,
): Promise<void> {
  const [task] = await sql<{
    hive_id: string;
    goal_id: string | null;
    assigned_to: string;
    title: string;
  }[]>`
    SELECT hive_id, goal_id, assigned_to, title
    FROM tasks
    WHERE id = ${taskId}
  `;
  if (!task) return;

  const title = `Quality doctor: ${task.title}`;
  const context = [
    `Cause: ${diagnosis.cause}`,
    diagnosis.details,
    "",
    `Recommendation: ${diagnosis.recommendation}`,
    diagnosis.cause === "missing_skill"
      ? "Future-work context only: parked hive_ideas 2dd4b249 and d96e8c31 may be relevant to later skill sourcing. They were not marked done and no skill generation was invoked."
      : null,
  ].filter((line): line is string => line !== null).join("\n");

  if (diagnosis.cause === "wrong_model") {
    await sql`
      INSERT INTO decisions (hive_id, goal_id, task_id, title, context, recommendation, priority, status, kind)
      VALUES (
        ${task.hive_id}, ${task.goal_id}, ${taskId}, ${title},
        ${context},
        'Route through the existing model-efficiency sweeper guardrails before any model swap.',
        'normal', 'pending', ${QUALITY_DOCTOR_DECISION_KIND}
      )
    `;
    return;
  }

  if (diagnosis.cause === "missing_skill") {
    try {
      await createOrUpdateSkillCandidateFromSignal(sql, {
        hiveId: task.hive_id,
        roleSlug: task.assigned_to,
        taskId,
        signalType: "failure_pattern",
        summary: [
          `Quality doctor diagnosed a missing skill for "${task.title}".`,
          `Details: ${diagnosis.details}`,
          `Recommendation: ${diagnosis.recommendation}`,
        ].join("\n"),
        source: "quality-doctor",
      });
    } catch (error) {
      console.warn(
        `[skills] Failed to create/update skill candidate from quality doctor diagnosis for task ${taskId}:`,
        error,
      );
    }
  }

  await sql`
    INSERT INTO decisions (hive_id, goal_id, task_id, title, context, recommendation, options, priority, status, kind)
    VALUES (
      ${task.hive_id}, ${task.goal_id}, ${taskId}, ${title},
      ${context},
      ${diagnosis.cause === "wrong_role_or_brief"
        ? "Send this recommendation to the supervisor for reroute, split, or brief rewrite."
        : diagnosis.recommendation},
      ${diagnosis.options === undefined ? null : sql.json(diagnosis.options as unknown as Parameters<typeof sql.json>[0])},
      'normal', 'pending', ${QUALITY_DOCTOR_DECISION_KIND}
    )
  `;
}

function buildQualityDoctorBrief(
  task: {
    assigned_to: string;
    title: string;
    brief: string;
    result_summary: string | null;
  },
  evidence: {
    source: string;
    signalType: string;
    rating?: number | null;
    evidence: string;
    confidence: number;
  },
  workProduct: { summary: string | null; content: string | null } | undefined,
  logs: { chunk: string; type: string }[],
): string {
  return [
    "## Quality Doctor Diagnosis",
    "",
    "Use exactly one cause category:",
    "- wrong_model: output was shallow/generic but the agent had everything it needed. This is the only category that may route to model-swap guardrails.",
    "- missing_skill: agent lacked the procedure. Create a Tier 2 decision proposing skill generation or sourcing; do not auto-generate skills.",
    "- missing_tool_connector_credential: agent lacked required data/access, faked it, or skipped a step. Create a Tier 2 decision proposing connector/credential remediation; do not auto-install anything.",
    "- wrong_role_or_brief: task was assigned to the wrong role or the brief was malformed. Recommend reroute, split, or brief rewrite.",
    "",
    "Route-choice option discipline:",
    "- If the diagnosis will create an owner-tier route choice involving auth, runtime, third-party service, connector, credential, account, subscription, or product fork, include options[].",
    "- Before writing options[], mentally enumerate: (a) buy/add a new credential/key/account/subscription, (b) reuse an existing credential, connector, infrastructure path, or subscription the hive already has, including credentials table, env, Codex auth, Claude Code auth, or other known paid subscriptions, (c) switch to a different already-installed connector/path, and (d) defer.",
    "- List every technically feasible path from that set. Hiding the existing credential/subscription/infrastructure path while listing a new key/account/subscription is a known anti-pattern.",
    "- Example: if OpenAI image generation could plausibly use existing Codex subscription auth, include an option with key like existing-codex-subscription-auth before proposing a new OpenAI API key.",
    "",
    `Task: ${task.title}`,
    `Role: ${task.assigned_to}`,
    "",
    "### Brief",
    task.brief,
    "",
    "### Work Product / Deliverable",
    workProduct?.summary ? `Summary: ${workProduct.summary}` : "",
    truncate(workProduct?.content ?? task.result_summary ?? "(no work product found)", 2_000),
    "",
    "### Agent Session Log",
    logs.length > 0
      ? logs.map((log) => `[${log.type}] ${truncate(log.chunk, 500)}`).join("\n")
      : "(no task log rows found)",
    "",
    "### Quality Evidence",
    `Source: ${evidence.source}`,
    `Signal: ${evidence.signalType}`,
    evidence.rating !== undefined && evidence.rating !== null ? `Rating: ${evidence.rating}/10` : "",
    `Confidence: ${evidence.confidence}`,
    evidence.evidence,
    "",
    "Respond with one fenced JSON block only:",
    "```json",
    '{"cause":"wrong_model|missing_skill|missing_tool_connector_credential|wrong_role_or_brief","details":"...","recommendation":"...","options":[{"key":"existing-codex-subscription-auth","label":"Use existing Codex subscription auth","consequence":"Reuses an already-paid path if technically supported.","response":"approved"}]}',
    "```",
  ].filter(Boolean).join("\n");
}

function parseDecisionOptions(raw: unknown): DecisionOption[] | null {
  if (!Array.isArray(raw)) return null;
  const options: DecisionOption[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.key !== "string" || record.key.trim() === "") return null;
    if (typeof record.label !== "string" || record.label.trim() === "") return null;
    for (const field of ["consequence", "description", "response", "canonicalResponse", "canonical_response"]) {
      if (record[field] !== undefined && typeof record[field] !== "string") return null;
    }
    options.push({
      key: record.key.trim(),
      label: record.label.trim(),
      consequence: typeof record.consequence === "string" ? record.consequence : undefined,
      description: typeof record.description === "string" ? record.description : undefined,
      response: typeof record.response === "string" ? record.response : undefined,
      canonicalResponse: typeof record.canonicalResponse === "string" ? record.canonicalResponse : undefined,
      canonical_response: typeof record.canonical_response === "string" ? record.canonical_response : undefined,
    });
  }
  return options;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}
