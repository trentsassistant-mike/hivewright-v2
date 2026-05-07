/**
 * Task → MCP classifier. Decides which MCPs from the catalog a given task
 * brief is likely to need, so the per-role tools_config doesn't have to grant
 * the kitchen sink to be safe.
 *
 * Strategy: heuristic-first (keyword + role hint). Cheap, deterministic, no
 * LLM cost. The hooks are here for a future LLM-fallback when the heuristic
 * is uncertain — see classifyTaskTools's `mode` parameter.
 *
 * Used by session-builder when a role's tools_config.mcps is unset (null) —
 * an explicit per-role override always wins.
 */

import type { McpEntry } from "./mcp-catalog";
import { MCP_CATALOG } from "./mcp-catalog";

export interface ClassifierInput {
  taskBrief: string;
  taskTitle: string;
  roleSlug: string;
}

export interface ClassifierResult {
  /** MCP slugs the task is granted access to. */
  mcps: string[];
  /** Why each was chosen — surfaced in task_logs for visibility. */
  reasons: string[];
}

interface KeywordRule {
  mcp: string;
  /** Words/phrases that, if present (case-insensitive), grant this MCP. */
  triggers: RegExp;
  reason: string;
}

const RULES: KeywordRule[] = [
  {
    mcp: "playwright",
    triggers:
      /\b(screenshot|browser|navigate|click|playwright|live[-\s]?ui|visual\s+(check|verify|qa)|dashboard\s+verify|render(s|ed|ing)?\s+(correctly|the|in)|take\s+a\s+screenshot|console\s+errors?)\b/i,
    reason: "task brief mentions browser/UI verification — granting playwright MCP",
  },
  {
    mcp: "github",
    triggers:
      /\b(github|pull\s+request|\bPR\b|\bissue\b|merge|commit\s+(history|log)|repo(sitory)?\s+(view|inspect|search)|gh\s+(api|pr|issue))\b/i,
    reason: "task brief mentions GitHub operations — granting github MCP",
  },
  {
    mcp: "context7",
    triggers:
      /\b(docs?\s+(for|on|about)|library\s+docs|api\s+(reference|docs)|context7|how\s+do\s+i\s+use|latest\s+version\s+of)\b/i,
    reason: "task brief mentions docs/library lookups — granting context7 MCP",
  },
  {
    mcp: "sequential-thinking",
    triggers:
      /\b(plan(ning)?\s+(out|the)|step[-\s]?by[-\s]?step|decompose|reason\s+through|carefully\s+plan|multi[-\s]?step)\b/i,
    reason: "task brief mentions multi-step reasoning — granting sequential-thinking MCP",
  },
];

/** Roles that almost always do a particular kind of work, regardless of brief wording. */
const ROLE_DEFAULTS: Record<string, string[]> = {
  qa: ["playwright"],
  "design-agent": ["playwright"],
  "security-auditor": ["playwright", "github"],
  "code-review-agent": ["github"],
  "research-analyst": ["context7", "sequential-thinking"],
  "goal-supervisor": ["sequential-thinking"],
  doctor: ["sequential-thinking"],
};

const KNOWN_MCP_SLUGS = new Set(MCP_CATALOG.map((e: McpEntry) => e.slug));

/**
 * @param mode "heuristic" — keyword + role hints (free, fast, deterministic).
 *             "off"       — return empty list (caller falls back to runtime defaults).
 */
export function classifyTaskTools(
  input: ClassifierInput,
  mode: "heuristic" | "off" = "heuristic",
): ClassifierResult {
  if (mode === "off") return { mcps: [], reasons: [] };

  const haystack = `${input.taskTitle}\n${input.taskBrief}`;
  const granted = new Set<string>();
  const reasons: string[] = [];

  // Role-baseline grants
  const roleDefaults = ROLE_DEFAULTS[input.roleSlug] ?? [];
  for (const slug of roleDefaults) {
    if (KNOWN_MCP_SLUGS.has(slug) && !granted.has(slug)) {
      granted.add(slug);
      reasons.push(`role '${input.roleSlug}' baseline → ${slug}`);
    }
  }

  // Keyword-triggered grants
  for (const rule of RULES) {
    if (granted.has(rule.mcp)) continue;
    if (!KNOWN_MCP_SLUGS.has(rule.mcp)) continue;
    if (rule.triggers.test(haystack)) {
      granted.add(rule.mcp);
      reasons.push(rule.reason);
    }
  }

  return { mcps: Array.from(granted).sort(), reasons };
}

export const TASK_CLASSIFIER_MODE_DEFAULT: "heuristic" | "off" =
  (process.env.HW_TASK_TOOL_CLASSIFIER as "heuristic" | "off" | undefined) ?? "heuristic";
