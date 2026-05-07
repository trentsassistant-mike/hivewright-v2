import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "postgres";
import { CodexAdapter } from "./adapters/codex";
import type { SessionContext } from "./adapters/types";
import type { ClaimedTask } from "./dispatcher/types";
import {
  createInitiativeRun,
  finalizeInitiativeRun,
  findRecentCreatedDecisionByDedupeKey,
  recordInitiativeDecision,
  type InitiativeActionTaken,
} from "./initiative-engine/store";

export const LLM_RELEASE_SCAN_TRIGGER = "llm-release-scan";

const PROVIDER_SOURCES = [
  {
    provider: "anthropic",
    urls: [
      "https://docs.anthropic.com/en/docs/about-claude/models/overview",
      "https://docs.anthropic.com/en/docs/about-claude/pricing",
    ],
  },
  {
    provider: "openai",
    urls: [
      "https://platform.openai.com/docs/models",
      "https://openai.com/api/pricing/",
    ],
  },
  {
    provider: "google",
    urls: [
      "https://ai.google.dev/gemini-api/docs/models",
      "https://ai.google.dev/gemini-api/docs/pricing",
    ],
  },
  {
    provider: "meta",
    urls: [
      "https://www.llama.com/docs/model-cards-and-prompt-formats/",
      "https://www.llama.com/llama-downloads/",
    ],
  },
  {
    provider: "mistral",
    urls: [
      "https://docs.mistral.ai/getting-started/models/models_overview/",
      "https://mistral.ai/pricing",
    ],
  },
  {
    provider: "xai",
    urls: [
      "https://docs.x.ai/docs/models/",
      "https://docs.x.ai/docs/overview",
    ],
  },
] as const;

const MODEL_REGISTRY_TOUCHPOINTS = [
  "src/adapters/provider-config.ts",
  "src/app/(dashboard)/roles/page.tsx",
  "src/app/(dashboard)/setup/adapters/page.tsx",
  "src/app/(dashboard)/hives/new/page.tsx",
] as const;

const DECISION_COOLDOWN_HOURS = 24 * 30;

export interface LlmReleaseScanTrigger {
  kind: "schedule";
  scheduleId?: string | null;
}

export interface LlmReleaseScanInput {
  hiveId: string;
  trigger: LlmReleaseScanTrigger;
}

export interface ProviderSourceEvidence {
  provider: string;
  url: string;
  status: "ok" | "error";
  fetchedAt: string;
  researchMethod: "agent-web-search" | "direct-fetch";
  discoveredModelIds: string[];
  error?: string;
}

export interface CandidateModel {
  provider: string;
  modelId: string;
  name: string;
  sourceUrls: string[];
  pricing: {
    inputPer1MTokensUsd: number | null;
    outputPer1MTokensUsd: number | null;
    raw: string | null;
  };
  confidence: "high" | "medium" | "low";
  notes: string[];
  proposedPatchTargets: string[];
}

export interface LlmReleaseScanResult {
  runId: string;
  trigger: LlmReleaseScanTrigger;
  providersChecked: number;
  sourcesChecked: number;
  candidatesEvaluated: number;
  newModelsDetected: number;
  decisionsCreated: number;
  heartbeatRecorded: boolean;
  candidates: CandidateModel[];
  sourceEvidence: ProviderSourceEvidence[];
}

export interface ResearchSource {
  provider: string;
  url: string;
  ok: boolean;
  text: string;
  researchMethod: "agent-web-search" | "direct-fetch";
  error?: string;
}

export interface LlmReleaseScanOptions {
  researchOfficialSources?: () => Promise<ResearchSource[]>;
  /**
   * Explicit test/legacy seam. Production defaults to agent WebSearch research
   * so release detection uses the same web-capable execution path as agents.
   */
  fetchSource?: (url: string) => Promise<{ ok: boolean; status: number; text: string }>;
  now?: Date;
  repoRoot?: string;
}

export async function runLlmReleaseScan(
  sql: Sql,
  input: LlmReleaseScanInput,
  options: LlmReleaseScanOptions = {},
): Promise<LlmReleaseScanResult> {
  const now = options.now ?? new Date();
  const run = await createInitiativeRun(sql, {
    hiveId: input.hiveId,
    trigger: {
      type: LLM_RELEASE_SCAN_TRIGGER,
      ref: input.trigger.scheduleId ?? null,
    },
    guardrailConfig: {
      providers: PROVIDER_SOURCES.length,
      sourceCount: PROVIDER_SOURCES.reduce((sum, provider) => sum + provider.urls.length, 0),
      decisionCooldownHours: DECISION_COOLDOWN_HOURS,
      ownerGated: "true",
      autoApply: "false",
    },
  });

  try {
    const [registeredModelIds, researchSources] = await Promise.all([
      loadRegisteredModelIds(options.repoRoot),
      researchOfficialSources(options),
    ]);
    const sourceEvidence = buildSourceEvidence(researchSources, now);
    const candidates = detectCandidateModels(researchSources, registeredModelIds);
    const outcomes: Array<{ actionTaken: InitiativeActionTaken; createdDecisionId?: string | null }> = [];

    for (const candidate of candidates) {
      const dedupeKey = `${LLM_RELEASE_SCAN_TRIGGER}:${candidate.provider}:${candidate.modelId}`;
      const cooldown = await findRecentCreatedDecisionByDedupeKey(sql, {
        hiveId: input.hiveId,
        dedupeKey,
        cooldownHours: DECISION_COOLDOWN_HOURS,
      });
      if (cooldown) {
        await recordInitiativeDecision(sql, {
          runId: run.id,
          hiveId: input.hiveId,
          triggerType: LLM_RELEASE_SCAN_TRIGGER,
          candidateKey: dedupeKey,
          candidateRef: candidate.modelId,
          actionTaken: "suppress",
          rationale: `Suppressed duplicate LLM release proposal for ${candidate.modelId}; an owner-gated proposal already exists in the cooldown window.`,
          suppressionReason: "cooldown_active",
          dedupeKey,
          cooldownHours: DECISION_COOLDOWN_HOURS,
          evidence: { candidate, priorRunId: cooldown.run_id, priorDecisionRecordId: cooldown.id },
        });
        outcomes.push({ actionTaken: "suppress" });
        continue;
      }

      const decision = await createOwnerGatedModelDecision(sql, input.hiveId, candidate);
      await recordInitiativeDecision(sql, {
        runId: run.id,
        hiveId: input.hiveId,
        triggerType: LLM_RELEASE_SCAN_TRIGGER,
        candidateKey: dedupeKey,
        candidateRef: candidate.modelId,
        actionTaken: "decision",
        rationale: `Created owner-gated Tier-2 proposal for newly detected model ${candidate.modelId}.`,
        dedupeKey,
        cooldownHours: DECISION_COOLDOWN_HOURS,
        evidence: {
          candidate,
          governance: {
            tier: 2,
            autoApprovable: true,
            ownerGatedPatch: true,
            autoApply: false,
          },
        },
        actionPayload: buildDecisionPayload(candidate),
        createdDecisionId: decision.id,
      });
      outcomes.push({ actionTaken: "decision", createdDecisionId: decision.id });
    }

    if (candidates.length === 0) {
      await recordInitiativeDecision(sql, {
        runId: run.id,
        hiveId: input.hiveId,
        triggerType: LLM_RELEASE_SCAN_TRIGGER,
        candidateKey: `${LLM_RELEASE_SCAN_TRIGGER}:heartbeat:${now.toISOString()}`,
        actionTaken: "noop",
        rationale: "Weekly LLM release scan completed; no unregistered candidate models were found.",
        evidence: {
          kind: "llm-release-scan-heartbeat",
          heartbeat: true,
          checkedProviders: PROVIDER_SOURCES.map((source) => source.provider),
          sourceEvidence,
          registeredModelCount: registeredModelIds.size,
        },
      });
      outcomes.push({ actionTaken: "noop" });
    }

    await finalizeInitiativeRun(sql, {
      runId: run.id,
      status: "completed",
      evaluatedCandidates: candidates.length,
      createdCount: outcomes.filter((outcome) => outcome.actionTaken === "decision").length,
      createdGoals: 0,
      createdTasks: 0,
      createdDecisions: outcomes.filter((outcome) => outcome.actionTaken === "decision").length,
      suppressedCount: outcomes.filter((outcome) => outcome.actionTaken === "suppress").length,
      noopCount: outcomes.filter((outcome) => outcome.actionTaken === "noop").length,
      suppressionReasons: countSuppressions(outcomes),
      runFailures: sourceEvidence.filter((source) => source.status === "error").length,
      failureReason: null,
    });

    return {
      runId: run.id,
      trigger: input.trigger,
      providersChecked: PROVIDER_SOURCES.length,
      sourcesChecked: sourceEvidence.length,
      candidatesEvaluated: candidates.length,
      newModelsDetected: candidates.length,
      decisionsCreated: outcomes.filter((outcome) => outcome.actionTaken === "decision").length,
      heartbeatRecorded: candidates.length === 0,
      candidates,
      sourceEvidence,
    };
  } catch (error) {
    await finalizeInitiativeRun(sql, {
      runId: run.id,
      status: "failed",
      evaluatedCandidates: 0,
      createdCount: 0,
      createdGoals: 0,
      createdTasks: 0,
      createdDecisions: 0,
      suppressedCount: 0,
      noopCount: 0,
      suppressionReasons: {},
      runFailures: 1,
      failureReason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function researchOfficialSources(options: LlmReleaseScanOptions): Promise<ResearchSource[]> {
  if (options.researchOfficialSources) return options.researchOfficialSources();
  if (options.fetchSource) return fetchOfficialSources(options.fetchSource);
  return researchOfficialSourcesWithAgentWebSearch();
}

async function fetchOfficialSources(
  fetchSource: NonNullable<LlmReleaseScanOptions["fetchSource"]>,
): Promise<ResearchSource[]> {
  const sources = await Promise.all(
    PROVIDER_SOURCES.flatMap((provider) =>
      provider.urls.map(async (url) => {
        try {
          const response = await fetchSource(url);
          return {
            provider: provider.provider,
            url,
            ok: response.ok,
            text: response.text,
            researchMethod: "direct-fetch" as const,
            error: response.ok ? undefined : `HTTP ${response.status}`,
          };
        } catch (error) {
          return {
            provider: provider.provider,
            url,
            ok: false,
            text: "",
            researchMethod: "direct-fetch" as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    ),
  );
  return sources;
}

async function researchOfficialSourcesWithAgentWebSearch(): Promise<ResearchSource[]> {
  const adapter = new CodexAdapter();
  const result = await adapter.execute(buildWebSearchResearchContext());
  if (!result.success) {
    throw new Error(result.failureReason ?? "LLM release scan WebSearch research failed");
  }

  const payload = parseWebSearchResearchPayload(result.output);
  return normalizeWebSearchResearchSources(payload.sources);
}

function buildWebSearchResearchContext(): SessionContext {
  const task: ClaimedTask = {
    id: "llm-release-scan-websearch",
    hiveId: "system",
    assignedTo: "research-analyst",
    createdBy: "llm-release-scan",
    status: "active",
    priority: 4,
    title: "Weekly LLM release scan WebSearch research",
    brief: buildWebSearchResearchPrompt(),
    parentTaskId: null,
    goalId: null,
    sprintNumber: null,
    qaRequired: false,
    acceptanceCriteria: "Return strict JSON evidence for each official provider source URL.",
    retryCount: 0,
    doctorAttempts: 0,
    failureReason: null,
    projectId: null,
  };

  return {
    task,
    roleTemplate: {
      slug: "research-analyst",
      department: "research",
      roleMd: "# Research Analyst\nUse WebSearch to verify current facts from official sources.",
      soulMd: null,
      toolsMd: null,
    },
    memoryContext: { roleMemory: [], hiveMemory: [], insights: [], capacity: "none" },
    skills: [],
    standingInstructions: [
      "Use WebSearch for current official release and pricing evidence.",
      "Do not infer models from unofficial pages.",
    ],
    goalContext: null,
    projectWorkspace: process.cwd(),
    model: process.env.HW_LLM_RELEASE_SCAN_MODEL || "openai-codex/gpt-5.5",
    fallbackModel: null,
    credentials: {},
    toolsConfig: null,
  };
}

function buildWebSearchResearchPrompt(): string {
  const sources = PROVIDER_SOURCES
    .map((provider) => `- ${provider.provider}: ${provider.urls.join(", ")}`)
    .join("\n");

  return `
Use WebSearch to inspect these official model release/pricing sources:
${sources}

Return only JSON with this shape:
{
  "sources": [
    {
      "provider": "openai",
      "url": "https://platform.openai.com/docs/models",
      "ok": true,
      "text": "Concise evidence text containing model IDs and nearby pricing snippets from the official source.",
      "error": null
    }
  ]
}

Rules:
- Include exactly one source object for every URL listed above.
- Use only the listed official URL or an official redirected/canonical equivalent for that source.
- Keep each text field under 2500 characters.
- If a source cannot be reached with WebSearch, set ok=false, text="", and explain error.
- Do not propose patches, create decisions, or include commentary outside the JSON.
`.trim();
}

function parseWebSearchResearchPayload(output: string): { sources: unknown[] } {
  const trimmed = output.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  const candidate = fenced ?? (jsonStart >= 0 && jsonEnd >= jsonStart ? trimmed.slice(jsonStart, jsonEnd + 1) : trimmed);
  const parsed = JSON.parse(candidate) as { sources?: unknown };
  if (!Array.isArray(parsed.sources)) {
    throw new Error("LLM release scan WebSearch output missing sources array");
  }
  return { sources: parsed.sources };
}

function normalizeWebSearchResearchSources(rawSources: unknown[]): ResearchSource[] {
  const byKey = new Map<string, ResearchSource>();
  for (const raw of rawSources) {
    if (!raw || typeof raw !== "object") continue;
    const source = raw as { provider?: unknown; url?: unknown; ok?: unknown; text?: unknown; error?: unknown };
    const provider = typeof source.provider === "string" ? source.provider.toLowerCase() : "";
    const url = typeof source.url === "string" ? source.url : "";
    if (!provider || !url) continue;
    byKey.set(`${provider}:${url}`, {
      provider,
      url,
      ok: source.ok === true,
      text: typeof source.text === "string" ? source.text : "",
      researchMethod: "agent-web-search",
      error: typeof source.error === "string" ? source.error : undefined,
    });
  }

  return PROVIDER_SOURCES.flatMap((provider) =>
    provider.urls.map((url) => byKey.get(`${provider.provider}:${url}`) ?? {
      provider: provider.provider,
      url,
      ok: false,
      text: "",
      researchMethod: "agent-web-search" as const,
      error: "WebSearch research output did not include this official source URL.",
    }),
  );
}

function buildSourceEvidence(sources: ResearchSource[], now: Date): ProviderSourceEvidence[] {
  return sources.map((source) => ({
    provider: source.provider,
    url: source.url,
    status: source.ok ? "ok" : "error",
    fetchedAt: now.toISOString(),
    researchMethod: source.researchMethod,
    discoveredModelIds: extractProviderModels(source.provider, source.text).map((model) => model.modelId),
    error: source.error,
  }));
}

function detectCandidateModels(
  sources: ResearchSource[],
  registeredModelIds: Set<string>,
): CandidateModel[] {
  const byModel = new Map<string, CandidateModel>();
  for (const source of sources) {
    if (!source.ok) continue;
    const text = htmlToText(source.text);
    for (const discovered of extractProviderModels(source.provider, text)) {
      if (registeredModelIds.has(discovered.modelId)) continue;
      const existing = byModel.get(discovered.modelId);
      const pricing = extractPricingNearModel(text, discovered.rawName);
      if (existing) {
        existing.sourceUrls.push(source.url);
        if (!existing.pricing.raw && pricing.raw) existing.pricing = pricing;
        continue;
      }
      byModel.set(discovered.modelId, {
        provider: source.provider,
        modelId: discovered.modelId,
        name: discovered.rawName,
        sourceUrls: [source.url],
        pricing,
        confidence: pricing.raw ? "high" : "medium",
        notes: pricing.raw
          ? ["Official source names the model and nearby pricing text was found."]
          : ["Official source names the model; pricing was not found near the model text."],
        proposedPatchTargets: [...MODEL_REGISTRY_TOUCHPOINTS],
      });
    }
  }
  return [...byModel.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
}

function extractProviderModels(
  provider: string,
  rawText: string,
): Array<{ modelId: string; rawName: string }> {
  const text = htmlToText(rawText).toLowerCase();
  const patterns: Record<string, RegExp[]> = {
    anthropic: [/\bclaude-(?:opus|sonnet)-\d+(?:-\d+)?\b/g],
    openai: [/\b(?:gpt-\d+(?:\.\d+)?(?:-[a-z0-9]+)*|o\d+(?:-[a-z0-9]+)*)\b/g],
    google: [/\bgemini-\d+(?:\.\d+)?(?:-[a-z0-9]+)+\b/g],
    meta: [/\bllama-\d+(?:\.\d+)?(?:-[a-z0-9]+)*\b/g],
    mistral: [
      /\b(?:mistral|ministral|codestral|magistral)(?:-[a-z0-9]+)+\b/g,
    ],
    xai: [/\bgrok-\d+(?:\.\d+)?(?:-[a-z0-9]+)*\b/g],
  };
  const prefix: Record<string, string> = {
    anthropic: "anthropic",
    openai: "openai",
    google: "google",
    meta: "meta-llama",
    mistral: "mistral",
    xai: "xai",
  };
  const found = new Map<string, string>();
  for (const pattern of patterns[provider] ?? []) {
    for (const match of text.matchAll(pattern)) {
      const rawName = normalizeModelName(match[0]);
      if (isIgnoredModelName(provider, rawName)) continue;
      found.set(`${prefix[provider]}/${rawName}`, rawName);
    }
  }
  return [...found.entries()].map(([modelId, rawName]) => ({ modelId, rawName }));
}

function extractPricingNearModel(
  text: string,
  modelName: string,
): CandidateModel["pricing"] {
  const normalizedText = htmlToText(text);
  const index = normalizedText.toLowerCase().indexOf(modelName.toLowerCase());
  if (index < 0) {
    return { inputPer1MTokensUsd: null, outputPer1MTokensUsd: null, raw: null };
  }
  const nearby = normalizedText.slice(Math.max(0, index - 600), index + 1200);
  const input = nearby.match(/\$([0-9]+(?:\.[0-9]+)?)\s*(?:\/|per)?\s*(?:1m|million)[^.$]{0,80}\binput\b/i)
    ?? nearby.match(/\binput\b[^$]{0,80}\$([0-9]+(?:\.[0-9]+)?)/i);
  const output = nearby.match(/\$([0-9]+(?:\.[0-9]+)?)\s*(?:\/|per)?\s*(?:1m|million)[^.$]{0,80}\boutput\b/i)
    ?? nearby.match(/\boutput\b[^$]{0,80}\$([0-9]+(?:\.[0-9]+)?)/i);
  const rawPricing = nearby.match(/.{0,80}\$[0-9]+(?:\.[0-9]+)?.{0,180}/);
  return {
    inputPer1MTokensUsd: input ? Number(input[1]) : null,
    outputPer1MTokensUsd: output ? Number(output[1]) : null,
    raw: rawPricing?.[0].replace(/\s+/g, " ").trim() ?? null,
  };
}

async function loadRegisteredModelIds(repoRoot = process.cwd()): Promise<Set<string>> {
  const ids = new Set<string>();
  await Promise.all(
    MODEL_REGISTRY_TOUCHPOINTS.map(async (relativePath) => {
      const body = await readFile(path.join(repoRoot, relativePath), "utf8");
      const matches = body.matchAll(
        /\b(?:anthropic|openai|openai-codex|google|meta-llama|mistral|xai|openrouter)\/[a-z0-9._:-]+/gi,
      );
      for (const match of matches) {
        ids.add(match[0].toLowerCase());
      }
    }),
  );
  return ids;
}

async function createOwnerGatedModelDecision(
  sql: Sql,
  hiveId: string,
  candidate: CandidateModel,
): Promise<{ id: string }> {
  const payload = buildDecisionPayload(candidate);
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO decisions (hive_id, title, context, recommendation, priority, status, kind, options)
    VALUES (
      ${hiveId},
      ${`Tier-2: review new ${candidate.provider} model ${candidate.modelId}`},
      ${JSON.stringify(payload, null, 2)},
      ${`Approve only after owner review. If approved, patch the listed model registry touchpoints with ${candidate.modelId} and verified pricing; do not auto-apply from the scan runtime.`},
      'normal',
      'pending',
      'release_scan_model_proposal',
      ${sql.json({
        kind: "release_scan_model_proposal",
        modelProposal: {
          source: "release-scan",
          ...payload,
        },
        actions: [
          { label: "Approve model registry patch", action: "approve_model_registry_patch" },
          { label: "Dismiss candidate", action: "dismiss" },
        ],
      })}
    )
    RETURNING id
  `;
  return row;
}

function buildDecisionPayload(candidate: CandidateModel): Record<string, unknown> {
  return {
    tier: 2,
    category: "llm_model_release",
    autoApprovableStyle: true,
    ownerGatedPatch: true,
    autoApply: false,
    provider: candidate.provider,
    modelId: candidate.modelId,
    modelName: candidate.name,
    pricing: candidate.pricing,
    sourceUrls: candidate.sourceUrls,
    confidence: candidate.confidence,
    notes: candidate.notes,
    proposedPatchTargets: candidate.proposedPatchTargets,
  };
}

function countSuppressions(
  outcomes: Array<{ actionTaken: InitiativeActionTaken }>,
): Record<string, number> {
  const suppressed = outcomes.filter((outcome) => outcome.actionTaken === "suppress").length;
  return suppressed > 0 ? { cooldown_active: suppressed } : {};
}

function normalizeModelName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function isIgnoredModelName(provider: string, modelName: string): boolean {
  if (provider === "openai" && /^(gpt-4|gpt-3|o1|o3)(?:-|$)/.test(modelName)) return true;
  if (provider === "meta" && /^llama-[23](?:-|$)/.test(modelName)) return true;
  return false;
}

function htmlToText(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}
