import type { ModelCapabilityAxis } from "@/model-catalog/capability-scores";

export type ModelRoutingProfile =
  | "coding"
  | "tool_agent"
  | "research"
  | "writing"
  | "summarization"
  | "analysis"
  | "domain_sensitive"
  | "fast_simple"
  | "fallback_strong";

export interface ModelRoutingProfileConfig {
  profile: ModelRoutingProfile;
  minimumCapabilityScore: number;
  closeScoreDelta: number;
  weights: Partial<Record<ModelCapabilityAxis, number>>;
}

export const MODEL_ROUTING_PROFILES: Record<ModelRoutingProfile, ModelRoutingProfileConfig> = {
  coding: {
    profile: "coding",
    minimumCapabilityScore: 35,
    closeScoreDelta: 5,
    weights: {
      coding: 1,
      reasoning: 0.45,
      tool_use: 0.25,
      speed: 0.1,
    },
  },
  tool_agent: {
    profile: "tool_agent",
    minimumCapabilityScore: 35,
    closeScoreDelta: 5,
    weights: {
      tool_use: 1,
      reasoning: 0.4,
      coding: 0.25,
      long_context: 0.2,
    },
  },
  research: {
    profile: "research",
    minimumCapabilityScore: 35,
    closeScoreDelta: 5,
    weights: {
      search: 0.85,
      reasoning: 0.65,
      long_context: 0.35,
      overall_quality: 0.25,
    },
  },
  writing: {
    profile: "writing",
    minimumCapabilityScore: 35,
    closeScoreDelta: 5,
    weights: {
      writing: 1,
      reasoning: 0.25,
      overall_quality: 0.2,
    },
  },
  summarization: {
    profile: "summarization",
    minimumCapabilityScore: 30,
    closeScoreDelta: 6,
    weights: {
      writing: 0.55,
      long_context: 0.45,
      reasoning: 0.25,
      speed: 0.2,
    },
  },
  analysis: {
    profile: "analysis",
    minimumCapabilityScore: 35,
    closeScoreDelta: 5,
    weights: {
      reasoning: 1,
      math: 0.35,
      overall_quality: 0.3,
      long_context: 0.2,
    },
  },
  domain_sensitive: {
    profile: "domain_sensitive",
    minimumCapabilityScore: 35,
    closeScoreDelta: 4,
    weights: {
      reasoning: 0.6,
      finance: 0.4,
      legal: 0.4,
      health_medical: 0.4,
      overall_quality: 0.35,
    },
  },
  fast_simple: {
    profile: "fast_simple",
    minimumCapabilityScore: 20,
    closeScoreDelta: 8,
    weights: {
      speed: 0.85,
      cost: 0.45,
      overall_quality: 0.2,
    },
  },
  fallback_strong: {
    profile: "fallback_strong",
    minimumCapabilityScore: 45,
    closeScoreDelta: 4,
    weights: {
      overall_quality: 0.75,
      reasoning: 0.65,
      coding: 0.25,
      writing: 0.25,
      tool_use: 0.2,
    },
  },
};
