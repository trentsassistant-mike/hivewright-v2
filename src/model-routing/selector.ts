import type { ModelCapabilityScoreView } from "@/model-catalog/capability-scores";
import { MODEL_ROUTING_PROFILES, type ModelRoutingProfile } from "./profiles";
import {
  classifyModelRoutingTask,
  type ModelRoutingTaskContext,
} from "./task-classifier";

export const AUTO_MODEL_ROUTE = "auto";

export type ModelRouteSource = "manual_role" | "auto_policy" | "auto_unavailable";

export interface ModelRoutingCandidate {
  adapterType: string;
  model: string;
  enabled?: boolean;
  status?: "healthy" | "unknown" | "unhealthy" | "degraded" | "disabled";
  qualityScore?: number;
  costScore?: number;
  capabilityScores?: ModelCapabilityScoreView[];
  local?: boolean;
  roleSlugs?: string[];
  roleTypes?: string[];
}

export interface ModelRoutingOverride {
  enabled?: boolean;
  roleSlugs?: string[];
}

export interface ModelRoutingPolicy {
  preferences?: {
    costQualityBalance?: number;
  };
  routeOverrides?: Record<string, ModelRoutingOverride>;
  roleRoutes?: Record<string, {
    candidateModels?: string[];
  }>;
  candidates: ModelRoutingCandidate[];
}

export interface ResolveConfiguredModelRouteInput {
  roleSlug: string;
  roleType: string | null;
  manualAdapterType: string | null;
  manualModel: string | null;
  policy: ModelRoutingPolicy | null;
  taskContext?: Omit<ModelRoutingTaskContext, "roleSlug" | "roleType">;
}

export interface ResolvedModelRoute {
  adapterType: string | null;
  model: string | null;
  source: ModelRouteSource;
  reason: string;
  profile?: ModelRoutingProfile;
  explanation?: string;
  scoreBreakdown?: {
    selectedScore: number;
    candidates: Array<{
      model: string;
      adapterType: string;
      score: number;
      capabilityFit: number;
      costScore: number;
      speedScore: number;
      selected: boolean;
      missingAxes: string[];
      lowConfidenceAxes: string[];
    }>;
  };
}

export function resolveConfiguredModelRoute(
  input: ResolveConfiguredModelRouteInput,
): ResolvedModelRoute {
  const manualAdapterType = normalizeManualValue(input.manualAdapterType);
  const manualModel = normalizeManualValue(input.manualModel);
  const wantsAuto = manualAdapterType === null || manualModel === null;

  if (!wantsAuto && manualAdapterType && manualModel) {
    return {
      adapterType: manualAdapterType,
      model: manualModel,
      source: "manual_role",
      reason: "role has explicit adapter and model",
    };
  }

  const policy = input.policy;
  if (!policy?.candidates?.length) {
    return {
      adapterType: null,
      model: null,
      source: "auto_unavailable",
      reason: "auto model routing has no enabled candidates",
    };
  }

  const costQualityBalance = normalizeRoutingBalance(policy.preferences?.costQualityBalance);
  const { qualityWeight, costWeight } = weightsForRoutingBalance(costQualityBalance);
  const priorityReason = `routing priority ${routingPriorityLabel(costQualityBalance)}`;
  const allowlist = new Set(policy.roleRoutes?.[input.roleSlug]?.candidateModels ?? []);
  const classification = classifyModelRoutingTask({
    roleSlug: input.roleSlug,
    roleType: input.roleType,
    ...input.taskContext,
  });
  const profileConfig = MODEL_ROUTING_PROFILES[classification.profile];

  const scoredCandidates = policy.candidates
    .filter((candidate) => candidate.enabled !== false)
    .filter((candidate) => isCandidateHealthEligible(candidate.status))
    .filter((candidate) => manualAdapterType === null || candidate.adapterType === manualAdapterType)
    .filter((candidate) => manualModel === null || candidate.model === manualModel)
    .filter((candidate) => allowlist.size === 0 || allowlist.has(candidate.model))
    .filter((candidate) => !candidate.roleSlugs || candidate.roleSlugs.includes(input.roleSlug))
    .filter((candidate) => !candidate.roleTypes || (input.roleType !== null && candidate.roleTypes.includes(input.roleType)))
    .map((candidate) => scoreCandidate(candidate, {
      qualityWeight,
      costWeight,
      profileConfig,
    }));
  const profileFilteredCount = scoredCandidates.filter((candidate) => (
    hasCapabilityScores(candidate.candidate) &&
    candidate.capabilityFit < profileConfig.minimumCapabilityScore
  )).length;
  const ranked = scoredCandidates
    .filter((candidate) => (
      !hasCapabilityScores(candidate.candidate) ||
      candidate.capabilityFit >= profileConfig.minimumCapabilityScore
    ))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const hasCapabilityRankedCandidates = ranked.some((candidate) => hasCapabilityScores(candidate.candidate));
  const closeScoreWinner = best && hasCapabilityRankedCandidates
    ? ranked
      .filter((candidate) => best.score - candidate.score <= profileConfig.closeScoreDelta)
      .filter((candidate) => best.capabilityFit - candidate.capabilityFit <= profileConfig.closeScoreDelta)
      .sort((a, b) => a.costScore - b.costScore || b.score - a.score)[0]
    : undefined;
  const selectedScore = closeScoreWinner ?? best;
  const selected = selectedScore?.candidate;
  if (!selected) {
    return {
      adapterType: null,
      model: null,
      source: "auto_unavailable",
      reason: profileFilteredCount > 0
        ? `auto model routing has no enabled candidates matching profile capability>=${profileConfig.minimumCapabilityScore} for ${profileConfig.profile}`
        : "auto model routing has no enabled candidates",
    };
  }

  return {
    adapterType: selected.adapterType,
    model: selected.model,
    source: "auto_policy",
    reason: closeScoreWinner && best && closeScoreWinner.candidate !== best.candidate
      ? `selected by auto policy close score for ${profileConfig.profile} with ${priorityReason}`
      : `selected by auto policy for ${profileConfig.profile} with ${priorityReason}`,
    profile: profileConfig.profile,
    explanation: closeScoreWinner && best && closeScoreWinner.candidate !== best.candidate
      ? `Selected ${selected.model} using ${profileConfig.profile} profile because it was within close score delta ${profileConfig.closeScoreDelta} and had lower cost.`
      : `Selected ${selected.model} using ${profileConfig.profile} profile from ${classification.confidence}-confidence task classification.`,
    scoreBreakdown: {
      selectedScore: selectedScore.score,
      candidates: ranked.map((candidate) => ({
        model: candidate.candidate.model,
        adapterType: candidate.candidate.adapterType,
        score: candidate.score,
        capabilityFit: candidate.capabilityFit,
        costScore: candidate.costScore,
        speedScore: candidate.speedScore,
        selected: candidate.candidate === selected,
        missingAxes: candidate.missingAxes,
        lowConfidenceAxes: candidate.lowConfidenceAxes,
      })),
    },
  };
}

function normalizeManualValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === AUTO_MODEL_ROUTE) return null;
  return trimmed;
}

function isCandidateHealthEligible(status: ModelRoutingCandidate["status"]): boolean {
  if (!status) return true;
  return status === "healthy" || status === "degraded";
}

interface ScoreCandidateOptions {
  qualityWeight: number;
  costWeight: number;
  profileConfig: (typeof MODEL_ROUTING_PROFILES)[ModelRoutingProfile];
}

interface ScoredCandidate {
  candidate: ModelRoutingCandidate;
  score: number;
  capabilityFit: number;
  costScore: number;
  speedScore: number;
  missingAxes: string[];
  lowConfidenceAxes: string[];
}

function scoreCandidate(
  candidate: ModelRoutingCandidate,
  options: ScoreCandidateOptions,
): ScoredCandidate {
  const costScore = Number(candidate.costScore ?? 100);

  if (!hasCapabilityScores(candidate)) {
    const score =
      Number(candidate.qualityScore ?? 0) * options.qualityWeight -
      costScore * options.costWeight;

    return {
      candidate,
      score,
      capabilityFit: Number(candidate.qualityScore ?? 0),
      costScore,
      speedScore: 0,
      missingAxes: [],
      lowConfidenceAxes: [],
    };
  }

  const capabilityScores = new Map(candidate.capabilityScores.map((score) => [score.axis, score]));
  let weightedScore = 0;
  let knownWeight = 0;
  let totalPossibleWeight = 0;
  const missingAxes: string[] = [];
  const lowConfidenceAxes: string[] = [];

  for (const [axis, weight] of Object.entries(options.profileConfig.weights)) {
    if (axis === "cost") continue;
    totalPossibleWeight += weight;

    const score = capabilityScores.get(axis as ModelCapabilityScoreView["axis"]);
    if (!score && axis === "overall_quality" && candidate.qualityScore !== undefined) {
      knownWeight += weight;
      weightedScore += Number(candidate.qualityScore ?? 0) * weight;
      continue;
    }
    if (!score) {
      missingAxes.push(axis);
      continue;
    }

    knownWeight += weight;
    if (score.confidence === "low") {
      lowConfidenceAxes.push(axis);
    }

    weightedScore += Number(score.score ?? 0) * weight * confidenceMultiplier(score.confidence);
  }

  const rawCapabilityFit = knownWeight > 0 ? weightedScore / knownWeight : 0;
  const coverageRatio = totalPossibleWeight > 0 ? knownWeight / totalPossibleWeight : 0;
  const capabilityFit = rawCapabilityFit * coverageRatio;
  const profileCostWeight = Number(options.profileConfig.weights.cost ?? 0);
  const lowConfidencePenalty = lowConfidenceAxes.length * 4;
  const score =
    capabilityFit * options.qualityWeight -
    costScore * (options.costWeight + profileCostWeight) -
    lowConfidencePenalty;

  return {
    candidate,
    score,
    capabilityFit,
    costScore,
    speedScore: Number(capabilityScores.get("speed")?.score ?? 0),
    missingAxes,
    lowConfidenceAxes,
  };
}

function hasCapabilityScores(
  candidate: ModelRoutingCandidate,
): candidate is ModelRoutingCandidate & { capabilityScores: ModelCapabilityScoreView[] } {
  return Array.isArray(candidate.capabilityScores) && candidate.capabilityScores.length > 0;
}

function confidenceMultiplier(confidence: ModelCapabilityScoreView["confidence"]): number {
  if (confidence === "high") return 1;
  if (confidence === "medium") return 0.85;
  return 0.6;
}

function normalizeRoutingBalance(costQualityBalance: number | undefined): number {
  return clampRoutingBalance(
    typeof costQualityBalance === "number" && Number.isFinite(costQualityBalance)
      ? costQualityBalance
      : 50,
  );
}

function routingPriorityLabel(costQualityBalance: number): string {
  if (costQualityBalance < 50) {
    return `${costQualityBalance}/100 toward Cost`;
  }
  if (costQualityBalance > 50) {
    return `${costQualityBalance}/100 toward Quality`;
  }
  return "50/100 Balanced";
}

function weightsForRoutingBalance(
  costQualityBalance: number,
): { qualityWeight: number; costWeight: number } {
  const balance = costQualityBalance / 100;

  return {
    qualityWeight: 0.25 + balance * 1.75,
    costWeight: 2 - balance * 1.75,
  };
}

function clampRoutingBalance(value: number): number {
  return Math.max(0, Math.min(100, value));
}
