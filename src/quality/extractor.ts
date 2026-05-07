import type { Sql } from "postgres";
import { callGenerationModel, getDefaultConfig, type ModelCallerConfig } from "@/memory/model-caller";
import { maybeCreateQualityDoctorForSignal } from "./doctor";

export type QualitySignalType = "positive" | "negative" | "neutral";
export type QualitySignalSource = "implicit_ea" | "explicit_owner_feedback";

export const DEFAULT_QUALITY_SIGNAL_RECENCY_DAYS = 7;
export const DEFAULT_QUALITY_SIGNAL_CONFIDENCE_THRESHOLD = 0.65;
export const DEFAULT_TASK_MATCH_THRESHOLD = 0.45;
const TASK_MATCH_AMBIGUITY_MARGIN = 0.15;

const MAX_EVIDENCE_LENGTH = 300;
const VAGUE_RECENT_WORK_RE =
  /\b(that|the|this)\s+(fix|change|update|work|task|implementation|patch|thing|feature)\b/i;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "i",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "so",
  "that",
  "the",
  "this",
  "to",
  "was",
  "we",
  "with",
  "you",
  "your",
]);

export interface QualityExtractionContext {
  hiveId: string;
  ownerMessage: string;
  ownerMessageId?: string | null;
  recencyDays?: number;
  confidenceThreshold?: number;
  now?: Date;
}

export interface QualitySignalOperation {
  operation: "ADD" | "NOOP";
  signalType?: QualitySignalType;
  evidence?: string;
  confidence?: number;
  taskReference?: string;
  reason?: string;
}

export interface QualityExtractionResult {
  signals: QualitySignalOperation[];
  rawResponse: string;
}

export interface RecentCompletedTask {
  id: string;
  hiveId: string;
  title: string;
  brief: string;
  resultSummary: string | null;
  completedAt: Date;
  workProductText: string | null;
}

export interface StoredQualitySignal {
  id: string;
  taskId: string;
  signalType: QualitySignalType;
  evidence: string;
  confidence: number;
}

export interface ExtractImplicitQualitySignalsResult {
  extraction: QualityExtractionResult;
  storedSignals: StoredQualitySignal[];
  candidateTasks: RecentCompletedTask[];
}

export function buildQualityExtractionPrompt(ownerMessage: string): string {
  return `You are a quality-signal extraction system for HiveWright EA conversations.

Classify whether the owner message contains feedback about recent HiveWright work.

Return ADD only for a plausible quality signal:
- positive: praise that work was good, fixed, useful, correct, or improved
- negative: criticism that work is broken, wrong, incomplete, regressed, confusing, or poor
- neutral: a non-judgmental reference to recent work that may be useful as evidence

Return NOOP for unrelated chat, new requests, planning, greetings, or feedback about something other than HiveWright work.
Keep evidence short and quote only the minimum needed words from the owner message.

Owner message:
${ownerMessage}

Respond with ONLY a JSON object:
{
  "signals": [
    {
      "operation": "ADD|NOOP",
      "signalType": "positive|negative|neutral",
      "evidence": "short quote",
      "confidence": 0.0-1.0,
      "taskReference": "words that identify the relevant task/work, if present",
      "reason": "why NOOP, if applicable"
    }
  ]
}`;
}

export function parseQualityExtractionResponse(response: string): QualityExtractionResult {
  let cleaned = response.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(cleaned) as { signals?: unknown };
    if (!Array.isArray(parsed.signals)) {
      return { signals: [], rawResponse: response };
    }

    const signals = parsed.signals
      .filter((s): s is Record<string, unknown> => {
        if (s === null || typeof s !== "object") return false;
        return s.operation === "ADD" || s.operation === "NOOP";
      })
      .map((s): QualitySignalOperation => ({
        operation: s.operation as "ADD" | "NOOP",
        signalType: isSignalType(s.signalType) ? s.signalType : undefined,
        evidence: typeof s.evidence === "string" ? s.evidence : undefined,
        confidence: typeof s.confidence === "number" ? s.confidence : undefined,
        taskReference: typeof s.taskReference === "string" ? s.taskReference : undefined,
        reason: typeof s.reason === "string" ? s.reason : undefined,
      }));

    return { signals, rawResponse: response };
  } catch {
    return { signals: [], rawResponse: response };
  }
}

export async function extractImplicitQualitySignals(
  sql: Sql,
  ctx: QualityExtractionContext,
  modelConfig: ModelCallerConfig = getDefaultConfig(),
): Promise<ExtractImplicitQualitySignalsResult> {
  const candidateTasks = await loadRecentCompletedTasks(sql, ctx);
  if (candidateTasks.length === 0) {
    return {
      extraction: { signals: [], rawResponse: "" },
      storedSignals: [],
      candidateTasks,
    };
  }

  const response = await callGenerationModel(
    buildQualityExtractionPrompt(trimSensitiveEvidence(ctx.ownerMessage, 1_000)),
    modelConfig,
  );
  const extraction = parseQualityExtractionResponse(response);
  const threshold = ctx.confidenceThreshold ?? DEFAULT_QUALITY_SIGNAL_CONFIDENCE_THRESHOLD;
  const storedSignals: StoredQualitySignal[] = [];

  for (const signal of extraction.signals) {
    if (signal.operation !== "ADD" || !signal.signalType || !signal.evidence) continue;
    const confidence = clampConfidence(signal.confidence ?? 0);
    if (confidence < threshold) continue;

    const match = matchSignalToTask(signal, candidateTasks, ctx.ownerMessage);
    if (!match) continue;

    const evidence = trimSensitiveEvidence(signal.evidence, MAX_EVIDENCE_LENGTH);
    const [row] = await sql<StoredQualitySignal[]>`
      INSERT INTO task_quality_signals (
        task_id,
        hive_id,
        signal_type,
        source,
        evidence,
        confidence,
        owner_message_id
      )
      VALUES (
        ${match.id},
        ${ctx.hiveId},
        ${signal.signalType},
        'implicit_ea',
        ${evidence},
        ${confidence},
        ${ctx.ownerMessageId ?? null}
      )
      RETURNING id, task_id as "taskId", signal_type as "signalType", evidence, confidence
    `;
    storedSignals.push(row);
    await maybeCreateQualityDoctorForSignal(sql, match.id, {
      source: "implicit_ea",
      signalType: signal.signalType,
      evidence,
      confidence,
    });
  }

  return { extraction, storedSignals, candidateTasks };
}

export async function loadRecentCompletedTasks(
  sql: Sql,
  ctx: Pick<QualityExtractionContext, "hiveId" | "recencyDays" | "now">,
): Promise<RecentCompletedTask[]> {
  const now = ctx.now ?? new Date();
  const recencyDays = ctx.recencyDays ?? DEFAULT_QUALITY_SIGNAL_RECENCY_DAYS;
  const since = new Date(now.getTime() - recencyDays * 24 * 60 * 60 * 1000);

  return sql<RecentCompletedTask[]>`
    SELECT
      t.id,
      t.hive_id as "hiveId",
      t.title,
      t.brief,
      t.result_summary as "resultSummary",
      t.completed_at as "completedAt",
      NULLIF(
        string_agg(
          CONCAT_WS(' ', wp.summary, LEFT(wp.content, 1200)),
          ' '
          ORDER BY wp.created_at DESC
        ),
        ''
      ) as "workProductText"
    FROM tasks t
    LEFT JOIN work_products wp ON wp.task_id = t.id AND wp.hive_id = t.hive_id
    WHERE t.hive_id = ${ctx.hiveId}
      AND t.status = 'completed'
      AND t.completed_at IS NOT NULL
      AND t.completed_at >= ${since}
    GROUP BY t.id
    ORDER BY t.completed_at DESC
    LIMIT 20
  `;
}

export function matchSignalToTask(
  signal: QualitySignalOperation,
  tasks: RecentCompletedTask[],
  ownerMessage: string,
  threshold = DEFAULT_TASK_MATCH_THRESHOLD,
): RecentCompletedTask | null {
  const query = [
    signal.evidence ?? "",
    signal.taskReference ?? "",
    ownerMessage,
  ].join(" ");
  const queryTokens = tokenize(query);
  const scored = tasks
    .map((task) => ({ task, score: scoreTaskMatch(task, queryTokens, query) }))
    .filter((row) => row.score >= threshold)
    .sort((a, b) => b.score - a.score);

  if (scored.length > 0) {
    if (scored.length > 1 && scored[0].score - scored[1].score < TASK_MATCH_AMBIGUITY_MARGIN) {
      return null;
    }
    return scored[0].task;
  }

  if (
    tasks.length === 1 &&
    (signal.confidence ?? 0) >= 0.75 &&
    VAGUE_RECENT_WORK_RE.test(query)
  ) {
    return tasks[0];
  }

  return null;
}

function scoreTaskMatch(task: RecentCompletedTask, queryTokens: Set<string>, query: string): number {
  const taskText = [
    task.title,
    task.brief,
    task.resultSummary ?? "",
    task.workProductText ?? "",
  ].join(" ");
  const taskTokens = tokenize(taskText);
  const overlap = [...queryTokens].filter((token) => taskTokens.has(token));
  if (overlap.length === 0) return 0;

  const titleTokens = tokenize(task.title);
  const titleOverlap = overlap.filter((token) => titleTokens.has(token)).length;
  const exactTitle = task.title.length >= 8 && query.toLowerCase().includes(task.title.toLowerCase());

  const base = overlap.length / Math.max(3, Math.min(taskTokens.size, 12));
  const titleBonus = titleOverlap > 0 ? Math.min(0.25, titleOverlap * 0.08) : 0;
  const exactBonus = exactTitle ? 0.35 : 0;
  return Math.min(1, base + titleBonus + exactBonus);
}

function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  return new Set(tokens);
}

function trimSensitiveEvidence(text: string, maxLength: number): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b(?:password|token|secret|api[_ -]?key)\s*[:=]\s*\S+/gi, "$1: [redacted]")
    .trim()
    .slice(0, maxLength);
}

function isSignalType(value: unknown): value is QualitySignalType {
  return value === "positive" || value === "negative" || value === "neutral";
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
