import type { ModelCatalogEntry } from "./catalog";
import type { ModelCapabilityAxis, ModelCapabilityScoreInput } from "./capability-scores";
import { canonicalModelIdForAdapter } from "@/model-health/model-identity";

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

type KnownLiveModel = Omit<
  ModelCatalogEntry,
  | "costPerInputToken"
  | "costPerOutputToken"
  | "benchmarkQualityScore"
  | "routingCostScore"
  | "metadataSourceName"
  | "metadataSourceUrl"
>;

export type LiveMetadataTarget = KnownLiveModel;

const OPENAI_PRICING_URL = "https://openai.com/api/pricing/";
const ANTHROPIC_OPUS_URL = "https://www.anthropic.com/claude/opus";
const ANTHROPIC_SONNET_URL = "https://www.anthropic.com/claude/sonnet";
const GEMINI_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing";
const LLM_STATS_URL = "https://llm-stats.com/";
const LLM_STATS_FULL_LEADERBOARD_URL = "https://llm-stats.com/leaderboards/llm-leaderboard";
const LLM_STATS_OPEN_LEADERBOARD_URL = "https://llm-stats.com/leaderboards/open-llm-leaderboard";
const ARTIFICIAL_ANALYSIS_MODELS_URL = "https://artificialanalysis.ai/models";
const BENCHLM_LEADERBOARD_URL = "https://benchlm.ai/api/data/leaderboard?limit=300";
const ARTIFICIAL_ANALYSIS_QUALITY_URLS: Record<string, string> = {
  "openai-codex/gpt-5.5": "https://artificialanalysis.ai/models/gpt-5-5",
  "anthropic/claude-sonnet-4-6": "https://artificialanalysis.ai/models/claude-sonnet-4-6",
  "anthropic/claude-opus-4-7": "https://artificialanalysis.ai/models/claude-opus-4-7",
  "google/gemini-2.5-flash": "https://artificialanalysis.ai/models/gemini-2-5-flash",
  "google/gemini-3.1-pro-preview": "https://artificialanalysis.ai/models/gemini-3-1-pro-preview",
};

type BenchmarkQualitySource = "LLM Stats" | "Artificial Analysis" | "BenchLM leaderboard";

type BenchLmLeaderboardModel = {
  model?: unknown;
  creator?: unknown;
  overallScore?: unknown;
  categoryScores?: unknown;
};

type BenchLmLeaderboard = {
  models?: BenchLmLeaderboardModel[];
};

type BenchLmBenchmarkMatch = {
  modelVersionMatched: string;
  overallScore: number | null;
  categoryScores: Record<string, number>;
};

const OFFICIAL_COST_FALLBACKS = new Map<string, {
  input: number;
  output: number;
  sourceName: string;
  sourceUrl: string;
}>([
  ["openai-codex/gpt-5.5", { input: 5, output: 30, sourceName: "OpenAI API pricing", sourceUrl: OPENAI_PRICING_URL }],
  ["openai-codex/gpt-5.4", { input: 2.5, output: 15, sourceName: "OpenAI API pricing", sourceUrl: OPENAI_PRICING_URL }],
  ["anthropic/claude-opus-4-7", { input: 5, output: 25, sourceName: "Anthropic Opus pricing", sourceUrl: ANTHROPIC_OPUS_URL }],
  ["anthropic/claude-sonnet-4-6", { input: 3, output: 15, sourceName: "Anthropic Sonnet pricing", sourceUrl: ANTHROPIC_SONNET_URL }],
  ["google/gemini-2.5-flash", { input: 0.3, output: 2.5, sourceName: "Google Gemini API pricing", sourceUrl: GEMINI_PRICING_URL }],
  ["google/gemini-3.1-pro-preview", { input: 1.25, output: 10, sourceName: "Google Gemini API pricing", sourceUrl: GEMINI_PRICING_URL }],
  ["google/gemini-3.1-flash-lite-preview", { input: 0.25, output: 1.5, sourceName: "Google Gemini API pricing", sourceUrl: GEMINI_PRICING_URL }],
  ["qwen3:32b", { input: 0, output: 0, sourceName: "Local Ollama runtime", sourceUrl: "https://ollama.com/" }],
]);

const KNOWN_LIVE_MODELS: KnownLiveModel[] = [
  {
    provider: "openai",
    adapterType: "codex",
    modelId: "openai-codex/gpt-5.5",
    displayName: "GPT-5.5",
    family: "gpt-5",
    capabilities: ["text", "code", "reasoning"],
    local: false,
  },
  {
    provider: "openai",
    adapterType: "codex",
    modelId: "openai-codex/gpt-5.4",
    displayName: "GPT-5.4",
    family: "gpt-5",
    capabilities: ["text", "code", "reasoning"],
    local: false,
  },
  {
    provider: "anthropic",
    adapterType: "claude-code",
    modelId: "anthropic/claude-opus-4-7",
    displayName: "Claude Opus 4.7",
    family: "claude-opus",
    capabilities: ["text", "code", "reasoning"],
    local: false,
  },
  {
    provider: "anthropic",
    adapterType: "claude-code",
    modelId: "anthropic/claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    family: "claude-sonnet",
    capabilities: ["text", "code", "reasoning"],
    local: false,
  },
  {
    provider: "google",
    adapterType: "gemini",
    modelId: "google/gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    family: "gemini-flash",
    capabilities: ["text", "code"],
    local: false,
  },
  {
    provider: "google",
    adapterType: "gemini",
    modelId: "google/gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro Preview",
    family: "gemini-pro",
    capabilities: ["text", "code", "reasoning"],
    local: false,
  },
  {
    provider: "google",
    adapterType: "gemini",
    modelId: "google/gemini-3.1-flash-lite-preview",
    displayName: "Gemini 3.1 Flash Lite Preview",
    family: "gemini-flash",
    capabilities: ["text", "code"],
    local: false,
  },
  {
    provider: "local",
    adapterType: "ollama",
    modelId: "qwen3:32b",
    displayName: "Qwen3 32B",
    family: "qwen",
    capabilities: ["text", "code"],
    local: true,
  },
];

const LLM_STATS_CAPABILITY_COLUMNS: Array<{ name: string; axis: ModelCapabilityAxis }> = [
  { name: "Speed", axis: "speed" },
  { name: "Reasoning", axis: "reasoning" },
  { name: "Math", axis: "math" },
  { name: "Coding", axis: "coding" },
  { name: "Search", axis: "search" },
  { name: "Writing", axis: "writing" },
  { name: "Vision", axis: "vision" },
  { name: "Tools", axis: "tool_use" },
  { name: "Long Ctx", axis: "long_context" },
  { name: "Finance", axis: "finance" },
  { name: "Legal", axis: "legal" },
  { name: "Health", axis: "health_medical" },
];

export async function buildLiveModelCatalogEntries(
  fetchImpl: FetchLike = globalThis.fetch,
  targets: LiveMetadataTarget[] = KNOWN_LIVE_MODELS,
): Promise<ModelCatalogEntry[]> {
  const [
    openAiPricing,
    anthropicPricing,
    anthropicSonnetPricing,
    geminiPricing,
    llmStatsScores,
    artificialAnalysisScores,
    benchLmScores,
  ] = await Promise.all([
    fetchText(OPENAI_PRICING_URL, fetchImpl),
    fetchText(ANTHROPIC_OPUS_URL, fetchImpl),
    fetchText(ANTHROPIC_SONNET_URL, fetchImpl),
    fetchText(GEMINI_PRICING_URL, fetchImpl),
    fetchLlmStatsScores(fetchImpl),
    fetchArtificialAnalysisScores(fetchImpl),
    fetchBenchLmScores(fetchImpl, targets),
  ]);

  const costs = new Map(OFFICIAL_COST_FALLBACKS);
  setCost(costs, "openai-codex/gpt-5.5", parseSectionTokenPrices(openAiPricing, "GPT-5.5", ["GPT-5.4"]), "OpenAI API pricing", OPENAI_PRICING_URL);
  setCost(costs, "openai-codex/gpt-5.4", parseSectionTokenPrices(openAiPricing, "GPT-5.4", ["GPT-5.3", "Containers"]), "OpenAI API pricing", OPENAI_PRICING_URL);
  setCost(costs, "anthropic/claude-opus-4-7", parseAnthropicOpusPricing(anthropicPricing), "Anthropic Opus pricing", ANTHROPIC_OPUS_URL);
  setCost(costs, "anthropic/claude-sonnet-4-6", parseAnthropicOpusPricing(anthropicSonnetPricing), "Anthropic Sonnet pricing", ANTHROPIC_SONNET_URL);
  setCost(costs, "google/gemini-2.5-flash", parseSectionTokenPrices(geminiPricing, "Gemini 2.5 Flash", ["Gemini 2.5 Flash-Lite", "Gemini 2.5 Pro", "Gemini 3"]), "Google Gemini API pricing", GEMINI_PRICING_URL);
  setCost(costs, "google/gemini-3.1-pro-preview", parseSectionTokenPrices(geminiPricing, "Gemini 3.1 Pro", ["Gemini 3.1 Flash", "Gemini 3.1 Flash Lite", "Gemini 3 Pro"]), "Google Gemini API pricing", GEMINI_PRICING_URL);
  setCost(costs, "google/gemini-3.1-flash-lite-preview", parseSectionTokenPrices(geminiPricing, "Gemini 3.1 Flash Lite", ["Gemini 3.1 Flash", "Gemini 3 Pro", "Gemini 2.5"]), "Google Gemini API pricing", GEMINI_PRICING_URL);
  for (const target of uniqueLiveMetadataTargets([...targets, ...KNOWN_LIVE_MODELS])) {
    const parsed = parseOfficialCostForTarget(target, {
      openAiPricing,
      anthropicPricing,
      anthropicSonnetPricing,
      geminiPricing,
    });
    if (parsed) costs.set(target.modelId, parsed);
  }
  const maxLlmStatsQuality = Math.max(...Array.from(llmStatsScores.values()), 0);
  const maxArtificialAnalysisQuality = Math.max(...Array.from(artificialAnalysisScores.values()), 0);

  return uniqueLiveMetadataTargets([...targets, ...KNOWN_LIVE_MODELS]).map((model) => {
    const cost = costs.get(model.modelId);
    const llmStatsRawQuality = llmStatsScores.get(model.modelId) ?? null;
    const artificialAnalysisRawQuality = artificialAnalysisScores.get(model.modelId) ?? null;
    const benchLmQuality = benchLmScores.get(model.modelId)?.overallScore ?? null;
    const benchmarkQualityScore = llmStatsRawQuality !== null && maxLlmStatsQuality > 0
      ? Math.round((llmStatsRawQuality / maxLlmStatsQuality) * 100)
      : benchLmQuality !== null
        ? benchLmQuality
        : artificialAnalysisRawQuality !== null && maxArtificialAnalysisQuality > 0
          ? Math.round((artificialAnalysisRawQuality / maxArtificialAnalysisQuality) * 100)
          : null;
    const qualitySource = llmStatsRawQuality !== null
      ? "LLM Stats"
      : benchLmQuality !== null
        ? "BenchLM leaderboard"
        : artificialAnalysisRawQuality !== null
          ? "Artificial Analysis"
          : null;

    return {
      ...model,
      costPerInputToken: cost ? perMillionToPerToken(cost.input) : null,
      costPerOutputToken: cost ? perMillionToPerToken(cost.output) : null,
      benchmarkQualityScore,
      routingCostScore: cost ? routingCostScore(cost.input, cost.output) : null,
      metadataSourceName: sourceName(cost?.sourceName ?? null, qualitySource),
      metadataSourceUrl: cost?.sourceUrl ?? qualitySourceUrl(qualitySource),
    };
  });
}

export async function buildLiveModelCapabilityScores(
  fetchImpl: FetchLike = globalThis.fetch,
  targets: LiveMetadataTarget[] = KNOWN_LIVE_MODELS,
): Promise<ModelCapabilityScoreInput[]> {
  const models = uniqueLiveMetadataTargets([...targets, ...KNOWN_LIVE_MODELS]);
  const [llmStatsText, benchLmMatches] = await Promise.all([
    fetchText(LLM_STATS_FULL_LEADERBOARD_URL, fetchImpl),
    fetchBenchLmScores(fetchImpl, targets),
  ]);

  return [
    ...parseLlmStatsFullLeaderboardCapabilityScores(llmStatsText, targets),
    ...benchLmCapabilityScores(models, benchLmMatches),
  ];
}

export async function llmStatsBenchmarkMetadataForConfiguredModel(
  input: {
    provider: string;
    adapterType: string;
    modelId: string;
  },
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<Pick<ModelCatalogEntry, "benchmarkQualityScore" | "metadataSourceName" | "metadataSourceUrl"> | null> {
  const leaderboardText = await fetchText(LLM_STATS_OPEN_LEADERBOARD_URL, fetchImpl);
  for (const slug of llmStatsModelSlugCandidates(input)) {
    const score = parseLlmStatsOpenLeaderboardQuality(leaderboardText, slug);
    if (score === null) continue;
    return {
      benchmarkQualityScore: score,
      metadataSourceName: "LLM Stats open leaderboard",
      metadataSourceUrl: `${LLM_STATS_URL}models/${slug}/`,
    };
  }
  return null;
}

export function staticMetadataForConfiguredModel(input: {
  provider: string;
  adapterType: string;
  modelId: string;
}): Pick<
  ModelCatalogEntry,
  | "costPerInputToken"
  | "costPerOutputToken"
  | "benchmarkQualityScore"
  | "routingCostScore"
  | "metadataSourceName"
  | "metadataSourceUrl"
> | null {
  const adapterType = input.adapterType.trim();
  const modelId = canonicalModelIdForAdapter(adapterType, input.modelId.trim());
  const provider = input.provider.trim().toLowerCase();
  const local = provider === "local" || adapterType.toLowerCase() === "ollama";
  const cost = local
    ? { input: 0, output: 0, sourceName: "Local Ollama runtime", sourceUrl: "https://ollama.com/" }
    : OFFICIAL_COST_FALLBACKS.get(modelId);

  if (!cost) return null;
  return {
    costPerInputToken: perMillionToPerToken(cost.input),
    costPerOutputToken: perMillionToPerToken(cost.output),
    benchmarkQualityScore: null,
    routingCostScore: routingCostScore(cost.input, cost.output),
    metadataSourceName: cost.sourceName,
    metadataSourceUrl: cost.sourceUrl,
  };
}

async function fetchText(url: string, fetchImpl: FetchLike): Promise<string> {
  try {
    let response = await fetchImpl(url, fetchInitForSource(url));
    if (!response.ok && url.includes("openai.com")) {
      response = await fetchImpl(url, fetchInitForSource(url));
    }
    if (!response.ok) return "";
    return await response.text();
  } catch {
    return "";
  }
}

function fetchInitForSource(url: string): RequestInit | undefined {
  if (!url.includes("openai.com")) return undefined;
  return {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; HiveWright/1.0; +https://localhost)",
      "accept": "text/html,application/xhtml+xml",
    },
  };
}

function setCost(
  costs: Map<string, { input: number; output: number; sourceName: string; sourceUrl: string }>,
  modelId: string,
  price: { input: number; output: number } | null,
  sourceName: string,
  sourceUrl: string,
) {
  if (!price) return;
  costs.set(modelId, { ...price, sourceName, sourceUrl });
}

function parseSectionTokenPrices(
  text: string,
  label: string,
  nextLabels: string[],
): { input: number; output: number } | null {
  const section = extractSection(text, label, nextLabels);
  if (!section) return null;
  const input = numberAfter(section, /Input(?:\s+price)?[^$]{0,120}\$([0-9]+(?:\.[0-9]+)?)/i);
  const output = numberAfter(section, /Output(?:\s+price)?[^$]{0,160}\$([0-9]+(?:\.[0-9]+)?)/i);
  return input !== null && output !== null ? { input, output } : null;
}

function parseAnthropicOpusPricing(text: string): { input: number; output: number } | null {
  const match = normalizedText(text).match(/\$([0-9]+(?:\.[0-9]+)?)\s+per\s+million\s+input\s+tokens.{0,120}\$([0-9]+(?:\.[0-9]+)?)\s+per\s+million\s+output\s+tokens/i);
  if (!match) return null;
  return { input: Number(match[1]), output: Number(match[2]) };
}

function parseArtificialAnalysisScores(text: string): Map<string, number> {
  const normalized = normalizedText(text);
  const scores = new Map<string, number>();
  setQuality(scores, "openai-codex/gpt-5.5", normalized, ["GPT-5.5"]);
  setQuality(scores, "openai-codex/gpt-5.4", normalized, ["GPT-5.4"]);
  setQuality(scores, "anthropic/claude-opus-4-7", normalized, ["Claude Opus 4.7", "Opus 4.7"]);
  setQuality(scores, "anthropic/claude-sonnet-4-6", normalized, ["Claude Sonnet 4.6", "Sonnet 4.6"]);
  setQuality(scores, "google/gemini-2.5-flash", normalized, ["Gemini 2.5 Flash"]);
  setQuality(scores, "google/gemini-3.1-pro-preview", normalized, ["Gemini 3.1 Pro Preview", "Gemini 3.1 Pro"]);
  setQuality(scores, "google/gemini-3.1-flash-lite-preview", normalized, ["Gemini 3.1 Flash Lite Preview", "Gemini 3.1 Flash Lite"]);
  setQuality(scores, "qwen3:32b", normalized, ["Qwen3 32B", "Qwen 3 32B"]);
  return scores;
}

async function fetchArtificialAnalysisScores(fetchImpl: FetchLike): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const pageEntries = await Promise.all(Object.entries(ARTIFICIAL_ANALYSIS_QUALITY_URLS).map(
    async ([modelId, url]) => [modelId, await fetchText(url, fetchImpl)] as const,
  ));

  for (const [modelId, text] of pageEntries) {
    const score = parseArtificialAnalysisModelPageScore(text);
    if (score !== null) scores.set(modelId, score);
  }

  const indexText = await fetchText(ARTIFICIAL_ANALYSIS_MODELS_URL, fetchImpl);
  if (indexText.length > 0 && indexText.length < 100_000) {
    for (const [modelId, score] of parseArtificialAnalysisScores(indexText)) {
      if (!scores.has(modelId)) scores.set(modelId, score);
    }
  }

  return scores;
}

async function fetchBenchLmScores(
  fetchImpl: FetchLike,
  targets: LiveMetadataTarget[] = KNOWN_LIVE_MODELS,
): Promise<Map<string, BenchLmBenchmarkMatch>> {
  const text = await fetchText(BENCHLM_LEADERBOARD_URL, fetchImpl);
  if (!text) return new Map();

  let parsed: BenchLmLeaderboard;
  try {
    parsed = JSON.parse(text) as BenchLmLeaderboard;
  } catch {
    return new Map();
  }

  const rows = Array.isArray(parsed.models) ? parsed.models : [];
  const matches = new Map<string, BenchLmBenchmarkMatch>();
  const models = uniqueLiveMetadataTargets([...targets, ...KNOWN_LIVE_MODELS]);

  for (const target of models) {
    const creator = benchLmCreatorForTarget(target);
    if (!creator) continue;
    const targetNames = new Set(modelNameCandidates(target).map(normalizeBenchLmName).filter(Boolean));
    const row = rows.find((candidate) => {
      if (typeof candidate.model !== "string" || typeof candidate.creator !== "string") return false;
      return normalizeBenchLmName(candidate.creator) === creator &&
        targetNames.has(normalizeBenchLmName(candidate.model));
    });
    if (!row || typeof row.model !== "string") continue;

    const overallScore = typeof row.overallScore === "number" && Number.isFinite(row.overallScore)
      ? Math.max(0, Math.min(100, row.overallScore))
      : null;
    const categoryScores = parseBenchLmCategoryScores(row.categoryScores);
    if (overallScore === null && Object.keys(categoryScores).length === 0) continue;

    matches.set(target.modelId, {
      modelVersionMatched: row.model,
      overallScore,
      categoryScores,
    });
  }

  return matches;
}

const BENCHLM_CATEGORY_AXES: Record<string, ModelCapabilityAxis> = {
  reasoning: "reasoning",
  coding: "coding",
  math: "math",
  agentic: "tool_use",
  multimodalGrounded: "vision",
};

function benchLmCapabilityScores(
  targets: LiveMetadataTarget[],
  matches: Map<string, BenchLmBenchmarkMatch>,
): ModelCapabilityScoreInput[] {
  const scores: ModelCapabilityScoreInput[] = [];
  for (const model of targets) {
    const match = matches.get(model.modelId);
    if (!match) continue;
    if (match.overallScore !== null) {
      scores.push(benchLmCapabilityScore(model, match, "overall_quality", match.overallScore, "overallScore"));
    }
    for (const [category, score] of Object.entries(match.categoryScores)) {
      const axis = BENCHLM_CATEGORY_AXES[category];
      if (!axis) continue;
      scores.push(benchLmCapabilityScore(model, match, axis, score, category));
    }
  }
  return scores;
}

function benchLmCapabilityScore(
  model: LiveMetadataTarget,
  match: BenchLmBenchmarkMatch,
  axis: ModelCapabilityAxis,
  score: number,
  benchmarkName: string,
): ModelCapabilityScoreInput {
  return {
    modelCatalogId: null,
    provider: model.provider,
    adapterType: model.adapterType,
    modelId: model.modelId,
    canonicalModelId: canonicalModelIdForAdapter(model.adapterType, model.modelId),
    axis,
    score,
    rawScore: String(score),
    source: "BenchLM",
    sourceUrl: BENCHLM_LEADERBOARD_URL,
    benchmarkName,
    modelVersionMatched: match.modelVersionMatched,
    confidence: "high",
  };
}

function parseBenchLmCategoryScores(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const scores: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    scores[key] = Math.max(0, Math.min(100, raw));
  }
  return scores;
}

function benchLmCreatorForTarget(target: LiveMetadataTarget): string | null {
  const provider = target.provider.trim().toLowerCase();
  const adapterType = target.adapterType.trim().toLowerCase();
  if (provider === "openai" || adapterType === "codex") return "openai";
  if (provider === "anthropic" || adapterType === "claude-code") return "anthropic";
  if (provider === "google" || adapterType === "gemini") return "google";
  return null;
}

async function fetchLlmStatsScores(fetchImpl: FetchLike): Promise<Map<string, number>> {
  return parseLlmStatsScores(await fetchText(LLM_STATS_URL, fetchImpl));
}

function parseLlmStatsScores(text: string): Map<string, number> {
  const normalized = extractLlmStatsLeaderboardSection(normalizedText(text));
  const scores = new Map<string, number>();
  setLlmStatsScore(scores, "openai-codex/gpt-5.5", normalized, ["GPT-5.5"]);
  setLlmStatsScore(scores, "openai-codex/gpt-5.4", normalized, ["GPT-5.4"]);
  setLlmStatsScore(scores, "anthropic/claude-opus-4-7", normalized, ["Claude Opus 4.7"]);
  setLlmStatsScore(scores, "anthropic/claude-sonnet-4-6", normalized, ["Claude Sonnet 4.6"]);
  setLlmStatsScore(scores, "google/gemini-2.5-flash", normalized, ["Gemini 2.5 Flash"]);
  setLlmStatsScore(scores, "google/gemini-3.1-pro-preview", normalized, ["Gemini 3.1 Pro Preview", "Gemini 3.1 Pro"]);
  setLlmStatsScore(scores, "google/gemini-3.1-flash-lite-preview", normalized, ["Gemini 3.1 Flash Lite Preview", "Gemini 3.1 Flash Lite"]);
  setLlmStatsScore(scores, "qwen3:32b", normalized, ["Qwen3 32B", "Qwen 3 32B"]);
  return scores;
}

function parseLlmStatsFullLeaderboardCapabilityScores(
  text: string,
  targets: LiveMetadataTarget[] = KNOWN_LIVE_MODELS,
): ModelCapabilityScoreInput[] {
  const normalized = normalizedText(text);
  const scores: ModelCapabilityScoreInput[] = [
    ...parseLlmStatsJsonCapabilityScores(text, targets),
  ];
  const models = uniqueLiveMetadataTargets([...targets, ...KNOWN_LIVE_MODELS]);

  for (const model of models) {
    const matched = extractModelRow(normalized, model, models);
    const row = matched?.row ?? "";
    if (!row) continue;

    const cells = tokenizeLlmStatsRowAfterModelLabel(row, matched?.label ?? model.displayName);
    const speedIndex = cells.findIndex((cell, index) => cells[index + 1]?.toLowerCase() === "c/s" && numericCellValue(cell) !== null);
    if (speedIndex === -1) continue;

    const axisCells = [
      cells[speedIndex],
      ...cells.slice(speedIndex + 3, speedIndex + 3 + LLM_STATS_CAPABILITY_COLUMNS.length - 1),
    ];

    for (let i = 0; i < LLM_STATS_CAPABILITY_COLUMNS.length; i += 1) {
      const column = LLM_STATS_CAPABILITY_COLUMNS[i];
      const axisValue = column?.axis === "speed"
        ? speedCellValue(axisCells[i])
        : capabilityScoreCellValue(axisCells[i]);
      if (!column || !axisValue || !Number.isFinite(axisValue.value)) continue;

      scores.push({
        modelCatalogId: null,
        provider: model.provider,
        adapterType: model.adapterType,
        modelId: canonicalModelIdForAdapter(model.adapterType, model.modelId),
        canonicalModelId: canonicalModelIdForAdapter(model.adapterType, model.modelId),
        axis: column.axis,
        score: axisValue.value,
        rawScore: axisValue.raw,
        source: "LLM Stats",
        sourceUrl: LLM_STATS_FULL_LEADERBOARD_URL,
        benchmarkName: column.name,
        modelVersionMatched: matched?.label ?? model.displayName,
        confidence: "high",
      });
    }
  }

  return dedupeCapabilityScores(scores);
}

const LLM_STATS_JSON_CAPABILITY_FIELDS: Array<{
  field: string;
  name: string;
  axis: ModelCapabilityAxis;
}> = [
  { field: "throughput", name: "Throughput", axis: "speed" },
  { field: "index_reasoning", name: "Reasoning Index", axis: "reasoning" },
  { field: "index_math", name: "Math Index", axis: "math" },
  { field: "index_code", name: "Code Index", axis: "coding" },
  { field: "index_search", name: "Search Index", axis: "search" },
  { field: "index_communication", name: "Communication Index", axis: "writing" },
  { field: "index_vision", name: "Vision Index", axis: "vision" },
  { field: "index_tool_calling", name: "Tool Calling Index", axis: "tool_use" },
  { field: "index_long_context", name: "Long Context Index", axis: "long_context" },
  { field: "index_finance", name: "Finance Index", axis: "finance" },
  { field: "index_legal", name: "Legal Index", axis: "legal" },
  { field: "index_healthcare", name: "Healthcare Index", axis: "health_medical" },
];

function parseLlmStatsJsonCapabilityScores(
  text: string,
  targets: LiveMetadataTarget[] = KNOWN_LIVE_MODELS,
): ModelCapabilityScoreInput[] {
  const rows = extractLlmStatsJsonRows(text);
  if (rows.length === 0) return [];

  const scores: ModelCapabilityScoreInput[] = [];
  const models = uniqueLiveMetadataTargets([...targets, ...KNOWN_LIVE_MODELS]);
  for (const model of models) {
    const row = findLlmStatsJsonRow(rows, model);
    if (!row) continue;
    const modelVersionMatched = typeof row.name === "string" ? row.name : model.displayName;
    const modelId = canonicalModelIdForAdapter(model.adapterType, model.modelId);

    for (const column of LLM_STATS_JSON_CAPABILITY_FIELDS) {
      const raw = numericJsonRowValue(row, column.field);
      if (raw === null) continue;
      const axisValue = column.axis === "speed"
        ? raw
        : Math.max(0, Math.min(100, raw));
      if (column.axis !== "speed" && raw < 0) continue;

      scores.push({
        modelCatalogId: null,
        provider: model.provider,
        adapterType: model.adapterType,
        modelId,
        canonicalModelId: modelId,
        axis: column.axis,
        score: axisValue,
        rawScore: String(raw),
        source: "LLM Stats",
        sourceUrl: LLM_STATS_FULL_LEADERBOARD_URL,
        benchmarkName: column.name,
        modelVersionMatched,
        confidence: "high",
      });
    }
  }

  return scores;
}

function extractLlmStatsJsonRows(text: string): Array<Record<string, unknown>> {
  const normalized = text.replace(/\\"/g, "\"");
  const rows: Array<Record<string, unknown>> = [];
  const rowPattern = /\{[^{}]*"model_id"\s*:\s*"[^"]+"[^{}]*\}/g;
  for (const match of normalized.matchAll(rowPattern)) {
    try {
      const row = JSON.parse(match[0]) as Record<string, unknown>;
      rows.push(row);
    } catch {
      // Ignore partial JSON fragments from page scripts.
    }
  }
  return rows;
}

function findLlmStatsJsonRow(
  rows: Array<Record<string, unknown>>,
  target: LiveMetadataTarget,
): Record<string, unknown> | null {
  const slugs = new Set(llmStatsModelSlugCandidates(target).map((slug) => slug.toLowerCase()));
  const names = new Set(modelNameCandidates(target).map((name) => normalizeBenchLmName(name)));

  return rows.find((row) => {
    const modelId = typeof row.model_id === "string" ? row.model_id.toLowerCase() : "";
    const name = typeof row.name === "string" ? normalizeBenchLmName(row.name) : "";
    return (modelId && slugs.has(modelId)) || (name && names.has(name));
  }) ?? null;
}

function numericJsonRowValue(row: Record<string, unknown>, field: string): number | null {
  const value = row[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dedupeCapabilityScores(scores: ModelCapabilityScoreInput[]) {
  const seen = new Set<string>();
  const unique: ModelCapabilityScoreInput[] = [];
  for (const score of scores) {
    const key = [
      score.provider,
      score.adapterType,
      score.canonicalModelId,
      score.axis,
      score.source,
      score.benchmarkName,
    ].map((value) => value.toLowerCase()).join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(score);
  }
  return unique;
}

function tokenizeLlmStatsRowAfterModelLabel(row: string, displayName: string) {
  const rest = row.slice(displayName.length).trim();
  return rest.split(/\s+/).filter(Boolean);
}

function speedCellValue(raw: string | undefined): { raw: string; value: number } | null {
  const value = numericCellValue(raw);
  if (value === null) return null;
  return { raw: raw ?? "", value };
}

function capabilityScoreCellValue(raw: string | undefined): { raw: string; value: number } | null {
  const value = numericCellValue(raw);
  if (value === null || value < 0 || value > 100) return null;
  return { raw: raw ?? "", value };
}

function numericCellValue(raw: string | undefined): number | null {
  if (!raw || raw === "-") return null;
  const normalized = raw.replace(/,/g, "");
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function parseLlmStatsOpenLeaderboardQuality(text: string, modelSlug: string): number | null {
  const normalized = text.replace(/\\"/g, "\"");
  const escapedSlug = escapeRegExp(modelSlug);
  const match = normalized.match(new RegExp(`\\{[^{}]*"model_id"\\s*:\\s*"${escapedSlug}"[^{}]*\\}`));
  if (!match?.[0]) return null;

  let row: Record<string, unknown>;
  try {
    row = JSON.parse(match[0]);
  } catch {
    return null;
  }

  return weightedLlmStatsOpenLeaderboardScore(row);
}

function weightedLlmStatsOpenLeaderboardScore(row: Record<string, unknown>): number | null {
  const parts: Array<{ value: number | null; weight: number }> = [
    { value: numericRowValue(row, "index_reasoning"), weight: 25 },
    { value: numericRowValue(row, "index_code"), weight: 25 },
    { value: averageScorePercentage(row, ["hle_score", "mmmu_pro_score", "simpleqa_score"]), weight: 15 },
    { value: numericRowValue(row, "index_tool_calling"), weight: 20 },
    { value: numericRowValue(row, "index_long_context"), weight: 10 },
    { value: numericRowValue(row, "index_vision"), weight: 5 },
  ];

  let total = 0;
  let weight = 0;
  for (const part of parts) {
    if (part.value === null) continue;
    total += Math.min(100, Math.max(0, part.value)) * part.weight;
    weight += part.weight;
  }
  if (weight === 0) return null;
  return Math.round(total / weight);
}

function averageScorePercentage(row: Record<string, unknown>, fields: string[]) {
  const values = fields
    .map((field) => numericRowValue(row, field))
    .filter((value): value is number => value !== null)
    .map((value) => value <= 1 ? value * 100 : value);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function numericRowValue(row: Record<string, unknown>, field: string): number | null {
  const value = row[field];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function llmStatsModelSlugCandidates(input: {
  provider: string;
  adapterType: string;
  modelId: string;
}) {
  const canonicalModelId = canonicalModelIdForAdapter(input.adapterType, input.modelId.trim()).toLowerCase();
  const bareModelId = canonicalModelId.replace(/^ollama\//, "");
  const mapped: Record<string, string[]> = {
    "gemma4:e4b": ["gemma-4-e4b-it"],
    "qwen3.6:35b": ["qwen3.6-35b-a3b"],
  };
  const slugs = [
    ...(mapped[bareModelId] ?? []),
    bareModelId
      .replace(/^([^0-9]*)([0-9])/, "$1-$2")
      .replace(/:/g, "-")
      .replace(/_/g, "-")
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, ""),
  ];

  return [...new Set(slugs.filter(Boolean))];
}

function extractLlmStatsLeaderboardSection(text: string) {
  const start = text.indexOf("Rank Model LLM Stats");
  if (start === -1) return text;
  const recent = text.indexOf("Recent", start);
  return text.slice(start, recent === -1 ? undefined : recent);
}

function setLlmStatsScore(scores: Map<string, number>, modelId: string, text: string, aliases: string[]) {
  for (const alias of aliases) {
    const escaped = escapeRegExp(alias);
    const match = text.match(new RegExp(`${escaped}(?:\\s+(?:NEW|UNRELEASED))?\\s+[A-Za-z][A-Za-z\\s./-]{1,80}?\\s+([0-9]+(?:\\.[0-9]+)?)\\s+`, "i"));
    if (!match?.[1]) continue;
    const score = Number(match[1]);
    if (Number.isFinite(score)) {
      scores.set(modelId, score);
      return;
    }
  }
}

function parseArtificialAnalysisModelPageScore(text: string): number | null {
  const normalized = normalizedText(text);
  return numberAfter(
    normalized,
    /([0-9]+(?:\.[0-9]+)?)\s+on\s+the\s+Artificial\s+Analysis\s+Intelligence\s+Index/i,
  );
}

function setQuality(scores: Map<string, number>, modelId: string, text: string, aliases: string[]) {
  for (const alias of aliases) {
    const escaped = escapeRegExp(alias);
    const patterns = [
      new RegExp(`${escaped}.{0,160}?(?:Intelligence Index|scores?|score)[^0-9]{0,30}([0-9]+(?:\\.[0-9]+)?)`, "i"),
      new RegExp(`(?:Intelligence Index|scores?|score)[^0-9]{0,30}([0-9]+(?:\\.[0-9]+)?).{0,160}?${escaped}`, "i"),
    ];
    for (const pattern of patterns) {
      const value = numberAfter(text, pattern);
      if (value !== null) {
        scores.set(modelId, value);
        return;
      }
    }
  }
}

function extractSection(text: string, label: string, nextLabels: string[]) {
  const normalized = normalizedText(text);
  const start = normalized.toLowerCase().indexOf(label.toLowerCase());
  if (start === -1) return "";
  let end = normalized.length;
  for (const nextLabel of nextLabels) {
    const next = normalized.toLowerCase().indexOf(nextLabel.toLowerCase(), start + label.length);
    if (next !== -1 && next < end) end = next;
  }
  return normalized.slice(start, end);
}

function numberAfter(text: string, pattern: RegExp): number | null {
  const match = text.match(pattern);
  if (!match?.[1]) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function parseOfficialCostForTarget(
  target: LiveMetadataTarget,
  sources: {
    openAiPricing: string;
    anthropicPricing: string;
    anthropicSonnetPricing: string;
    geminiPricing: string;
  },
): { input: number; output: number; sourceName: string; sourceUrl: string } | null {
  const provider = target.provider.trim().toLowerCase();
  const adapterType = target.adapterType.trim().toLowerCase();
  const candidates = modelNameCandidates(target);

  if (provider === "openai" || adapterType === "codex") {
    const price = parseTokenPricesNearAliases(sources.openAiPricing, candidates);
    return price ? { ...price, sourceName: "OpenAI API pricing", sourceUrl: OPENAI_PRICING_URL } : null;
  }

  if (provider === "google" || adapterType === "gemini") {
    const price = parseTokenPricesNearAliases(sources.geminiPricing, candidates);
    return price ? { ...price, sourceName: "Google Gemini API pricing", sourceUrl: GEMINI_PRICING_URL } : null;
  }

  if (provider === "anthropic" || adapterType === "claude-code") {
    const text = target.modelId.includes("sonnet") || target.displayName.toLowerCase().includes("sonnet")
      ? sources.anthropicSonnetPricing
      : sources.anthropicPricing;
    const price = parseTokenPricesNearAliases(text, candidates);
    if (price) {
      return {
        ...price,
        sourceName: target.modelId.includes("sonnet") || target.displayName.toLowerCase().includes("sonnet")
          ? "Anthropic Sonnet pricing"
          : "Anthropic Opus pricing",
        sourceUrl: target.modelId.includes("sonnet") || target.displayName.toLowerCase().includes("sonnet")
          ? ANTHROPIC_SONNET_URL
          : ANTHROPIC_OPUS_URL,
      };
    }
  }

  return null;
}

function parseTokenPricesNearAliases(text: string, aliases: string[]): { input: number; output: number } | null {
  const normalized = normalizedText(text);
  for (const alias of aliases) {
    const match = aliasMatch(normalized, alias);
    if (!match) continue;
    const start = match.index;
    const section = normalized.slice(start, start + 800);
    const input = numberAfter(section, /Input(?:\s+price)?[^$]{0,160}\$([0-9]+(?:\.[0-9]+)?)/i);
    const output = numberAfter(section, /Output(?:\s+price)?[^$]{0,200}\$([0-9]+(?:\.[0-9]+)?)/i);
    if (input !== null && output !== null) return { input, output };
  }
  return null;
}

function extractModelRow(
  text: string,
  target: LiveMetadataTarget,
  targets: LiveMetadataTarget[],
): { row: string; label: string } | null {
  const matched = modelNameCandidates(target)
    .map((candidate) => aliasMatch(text, candidate))
    .find((match) => match !== null);
  if (!matched) return null;

  const start = matched.index;

  let end = text.length;
  for (const model of targets) {
    if (model.modelId === target.modelId && model.adapterType === target.adapterType) continue;
    for (const label of modelNameCandidates(model)) {
      const nextMatch = aliasMatch(text.slice(start + matched.text.length), label);
      const next = nextMatch ? start + matched.text.length + nextMatch.index : -1;
      if (next !== -1 && next < end) end = next;
    }
  }

  return { row: text.slice(start, end), label: matched.text };
}

function uniqueLiveMetadataTargets(targets: LiveMetadataTarget[]) {
  const seen = new Set<string>();
  const unique: LiveMetadataTarget[] = [];
  for (const target of targets) {
    const key = `${target.provider}:${target.adapterType}:${target.modelId}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(target);
  }
  return unique;
}

function modelNameCandidates(target: LiveMetadataTarget) {
  const canonical = canonicalModelIdForAdapter(target.adapterType, target.modelId);
  const bare = canonical
    .replace(/^openai-codex\//, "")
    .replace(/^anthropic\//, "")
    .replace(/^google\//, "")
    .replace(/^ollama\//, "");
  const withoutDate = bare.replace(/-\d{8}$/, "").replace(/-\d{2}-\d{4}$/, "");
  const values = [
    target.displayName,
    bare,
    withoutDate,
    dottedModelVersionName(bare),
    dottedModelVersionName(withoutDate),
    bare.replace(/-/g, " "),
    withoutDate.replace(/-/g, " "),
    titleCaseModelName(bare.replace(/-/g, " ")),
    titleCaseModelName(withoutDate.replace(/-/g, " ")),
    titleCaseModelName(dottedModelVersionName(bare).replace(/-/g, " ")),
    titleCaseModelName(dottedModelVersionName(withoutDate).replace(/-/g, " ")),
  ];
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length >= 2))]
    .sort((a, b) => b.length - a.length);
}

function dottedModelVersionName(value: string) {
  return value.replace(/-(\d)-(\d)(?=$|-)/g, "-$1.$2");
}

function titleCaseModelName(value: string) {
  return value.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function aliasMatch(text: string, alias: string): { index: number; text: string } | null {
  const pattern = alias
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(escapeRegExp)
    .join("[\\s-]+");
  if (!pattern) return null;
  const match = text.match(new RegExp(pattern, "i"));
  if (match?.index === undefined || !match[0]) return null;
  return { index: match.index, text: match[0] };
}

function perMillionToPerToken(value: number) {
  if (value === 0) return "0";
  return (value / 1_000_000).toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

function routingCostScore(inputPerMillion: number, outputPerMillion: number) {
  return Math.min(100, Math.round((inputPerMillion + outputPerMillion) * 2));
}

function sourceName(costSourceName: string | null, qualitySource: BenchmarkQualitySource | null) {
  if (costSourceName && qualitySource) return `${costSourceName} + ${qualitySource}`;
  if (costSourceName) return costSourceName;
  if (qualitySource) return qualitySource;
  return null;
}

function qualitySourceUrl(qualitySource: BenchmarkQualitySource | null) {
  if (qualitySource === "LLM Stats") return LLM_STATS_URL;
  if (qualitySource === "Artificial Analysis") return ARTIFICIAL_ANALYSIS_MODELS_URL;
  if (qualitySource === "BenchLM leaderboard") return BENCHLM_LEADERBOARD_URL;
  return null;
}

function normalizedText(text: string) {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeBenchLmName(value: string) {
  const normalized = value
    .replace(/^openai-codex\//i, "")
    .replace(/^anthropic\//i, "")
    .replace(/^google\//i, "")
    .replace(/^ollama\//i, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b\d{8}\b/g, " ")
    .replace(/\b\d{2}\s+\d{4}\b/g, " ")
    .replace(/[^a-z0-9.]+/gi, " ")
    .replace(/\b(?:preview|latest|adaptive|thinking|high|medium|live|experimental|exp)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const claude = normalized.match(/^claude\s+(\d+(?:\.\d+)?)\s+(opus|sonnet|haiku)$/);
  if (claude?.[1] && claude[2]) {
    return `claude ${claude[2]} ${claude[1]}`;
  }
  return normalized;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
