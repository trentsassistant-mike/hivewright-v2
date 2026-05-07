import type { ChatProvider, ProviderId } from "@/llm";
import { getChatProvider } from "@/llm";
import { submitWorkIntake } from "@/app/api/work/route";
import { loadCredentials } from "@/credentials/manager";
import { buildHiveContextBlock } from "@/hives/context";
import { prependIdeaOriginPreface } from "@/ideas/origin";
import type { Sql } from "postgres";

export interface OpenIdeaForReview {
  id: string;
  title: string;
  body: string | null;
  created_at: Date;
}

export interface IdeasCuratorDecision {
  picked_idea_id?: string | null;
  fit_rationale: string;
  recommended_action: "promote" | "archive_low_fit" | "leave_open";
  goal_brief?: string;
}

export interface InvokeIdeasCuratorInput {
  hiveId: string;
  contextBlock: string;
  openIdeas: OpenIdeaForReview[];
}

export interface SubmitPromotedIdeaInput {
  hiveId: string;
  idea: OpenIdeaForReview;
  goalBrief: string;
}

export interface IdeasDailyReviewResult {
  skipped: boolean;
  reason?: "no-open-ideas";
  openIdeas: number;
  action?: "promote" | "archive_low_fit" | "leave_open";
  pickedIdeaId?: string | null;
  promotedGoalId?: string | null;
}

export interface RunIdeasDailyReviewOptions {
  buildContext?: (sql: Sql, hiveId: string) => Promise<string>;
  invokeCurator?: (
    input: InvokeIdeasCuratorInput,
  ) => Promise<IdeasCuratorDecision>;
  submitWork?: (
    input: SubmitPromotedIdeaInput,
  ) => Promise<{ id: string; type: "goal" | "task" }>;
}

export async function runIdeasDailyReview(
  sql: Sql,
  hiveId: string,
  options: RunIdeasDailyReviewOptions = {},
): Promise<IdeasDailyReviewResult> {
  const openIdeas = await sql<OpenIdeaForReview[]>`
    SELECT id, title, body, created_at
    FROM hive_ideas
    WHERE hive_id = ${hiveId}::uuid
      AND status = 'open'
    ORDER BY created_at ASC
  `;

  if (openIdeas.length === 0) {
    return {
      skipped: true,
      reason: "no-open-ideas",
      openIdeas: 0,
    };
  }

  const buildContext = options.buildContext ?? buildHiveContextBlock;
  const invokeCurator = options.invokeCurator ?? defaultInvokeCurator(sql);
  const submitWork = options.submitWork ?? defaultSubmitWork;

  const contextBlock = await buildContext(sql, hiveId);
  const decision = await invokeCurator({ hiveId, contextBlock, openIdeas });
  const pickedIdea = resolvePickedIdea(openIdeas, decision);

  if (!pickedIdea) {
    return {
      skipped: false,
      openIdeas: openIdeas.length,
      action: "leave_open",
      pickedIdeaId: null,
    };
  }

  if (decision.recommended_action === "promote") {
    const capReached = await alreadyPromotedToday(sql, hiveId);
    if (capReached) {
      const cappedAssessment = `${decision.fit_rationale}\n\nPromotion skipped: the one-idea-per-day cap has already been used for this hive today.`;
      await leaveIdeaOpen(sql, pickedIdea.id, cappedAssessment);
      return {
        skipped: false,
        openIdeas: openIdeas.length,
        action: "leave_open",
        pickedIdeaId: pickedIdea.id,
        promotedGoalId: null,
      };
    }

    const goalBrief = decision.goal_brief?.trim();
    if (!goalBrief) {
      throw new Error("ideas-curator promote action missing goal_brief");
    }

    const work = await submitWork({
      hiveId,
      idea: pickedIdea,
      goalBrief: prependIdeaOriginPreface(goalBrief, pickedIdea.id, pickedIdea.title),
    });
    if (work.type !== "goal") {
      throw new Error(`/api/work promotion returned type='${work.type}' instead of goal`);
    }

    await sql`
      UPDATE hive_ideas
      SET status = 'promoted',
          reviewed_at = NOW(),
          promoted_to_goal_id = ${work.id},
          ai_assessment = ${decision.fit_rationale},
          updated_at = NOW()
      WHERE id = ${pickedIdea.id}
    `;

    return {
      skipped: false,
      openIdeas: openIdeas.length,
      action: "promote",
      pickedIdeaId: pickedIdea.id,
      promotedGoalId: work.id,
    };
  }

  if (decision.recommended_action === "archive_low_fit") {
    await sql`
      UPDATE hive_ideas
      SET status = 'archived',
          reviewed_at = NOW(),
          ai_assessment = ${decision.fit_rationale},
          updated_at = NOW()
      WHERE id = ${pickedIdea.id}
    `;
    return {
      skipped: false,
      openIdeas: openIdeas.length,
      action: "archive_low_fit",
      pickedIdeaId: pickedIdea.id,
      promotedGoalId: null,
    };
  }

  await leaveIdeaOpen(sql, pickedIdea.id, decision.fit_rationale);
  return {
    skipped: false,
    openIdeas: openIdeas.length,
    action: "leave_open",
    pickedIdeaId: pickedIdea.id,
    promotedGoalId: null,
  };
}

async function leaveIdeaOpen(
  sql: Sql,
  ideaId: string,
  assessment: string,
): Promise<void> {
  await sql`
    UPDATE hive_ideas
    SET status = 'open',
        reviewed_at = NOW(),
        ai_assessment = ${assessment},
        updated_at = NOW()
    WHERE id = ${ideaId}
  `;
}

function resolvePickedIdea(
  openIdeas: OpenIdeaForReview[],
  decision: IdeasCuratorDecision,
): OpenIdeaForReview | null {
  if (!decision.picked_idea_id) return null;
  return openIdeas.find((idea) => idea.id === decision.picked_idea_id) ?? null;
}

async function alreadyPromotedToday(sql: Sql, hiveId: string): Promise<boolean> {
  const [row] = await sql<Array<{ exists: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM hive_ideas
      WHERE hive_id = ${hiveId}
        AND status = 'promoted'
        AND reviewed_at IS NOT NULL
        AND reviewed_at::date = CURRENT_DATE
    ) AS exists
  `;
  return Boolean(row?.exists);
}

function defaultSubmitWork(
  input: SubmitPromotedIdeaInput,
): Promise<{ id: string; type: "goal" | "task" }> {
  return submitWorkIntake({
    hiveId: input.hiveId,
    input: input.goalBrief,
    files: [],
    createdBy: "ideas-curator",
    forceType: "goal",
  });
}

function defaultInvokeCurator(sql: Sql) {
  return async (
    input: InvokeIdeasCuratorInput,
  ): Promise<IdeasCuratorDecision> => {
    const [role] = await sql<Array<{
      recommended_model: string | null;
      adapter_type: string | null;
      role_md: string | null;
    }>>`
      SELECT recommended_model, adapter_type, role_md
      FROM role_templates
      WHERE slug = 'ideas-curator'
      LIMIT 1
    `;

    const resolved = resolveProvider(role?.recommended_model, role?.adapter_type);
    const provider = await loadProviderForRole(sql, resolved.provider, "ideas-curator");
    const prompt = buildCuratorPrompt(input.contextBlock, input.openIdeas);
    const response = await provider.chat({
      system: role?.role_md?.trim() || DEFAULT_CURATOR_SYSTEM,
      user: prompt,
      model: resolved.model,
      temperature: 0.1,
      maxTokens: 700,
      timeoutMs: 45_000,
    });

    return parseCuratorDecision(response.text);
  };
}

const DEFAULT_CURATOR_SYSTEM = `You are Ideas Curator.
Pick at most one open idea.
Return only JSON matching:
{
  "picked_idea_id": "uuid-or-null",
  "fit_rationale": "string",
  "recommended_action": "promote" | "archive_low_fit" | "leave_open",
  "goal_brief": "string when recommended_action=promote"
}`;

function buildCuratorPrompt(
  contextBlock: string,
  openIdeas: OpenIdeaForReview[],
): string {
  const ideasBlock = openIdeas
    .map((idea, index) => {
      const body = idea.body?.trim() ? `\nBody: ${idea.body.trim()}` : "";
      return [
        `Idea ${index + 1}`,
        `ID: ${idea.id}`,
        `Title: ${idea.title}`,
        `Created: ${idea.created_at instanceof Date ? idea.created_at.toISOString() : String(idea.created_at)}`,
        body,
      ].join("\n");
    })
    .join("\n\n");

  return [
    contextBlock.trim(),
    "## Open Ideas",
    ideasBlock,
    "Choose exactly one idea when possible. If nothing fits well enough, return leave_open or archive_low_fit.",
    "If you recommend promote, goal_brief must be ready for /api/work and should not mention implementation details outside the idea itself.",
    "Return JSON only.",
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function parseCuratorDecision(text: string): IdeasCuratorDecision {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    throw new Error("ideas-curator output missing JSON object");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `ideas-curator output was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ideas-curator output root must be an object");
  }

  const root = parsed as Record<string, unknown>;
  if (
    root.picked_idea_id !== undefined &&
    root.picked_idea_id !== null &&
    typeof root.picked_idea_id !== "string"
  ) {
    throw new Error("ideas-curator picked_idea_id must be a string or null");
  }
  if (typeof root.fit_rationale !== "string" || root.fit_rationale.trim() === "") {
    throw new Error("ideas-curator fit_rationale must be a non-empty string");
  }
  if (
    root.recommended_action !== "promote" &&
    root.recommended_action !== "archive_low_fit" &&
    root.recommended_action !== "leave_open"
  ) {
    throw new Error("ideas-curator recommended_action must be promote | archive_low_fit | leave_open");
  }
  if (
    root.goal_brief !== undefined &&
    root.goal_brief !== null &&
    typeof root.goal_brief !== "string"
  ) {
    throw new Error("ideas-curator goal_brief must be a string when present");
  }
  if (
    root.recommended_action === "promote" &&
    (typeof root.goal_brief !== "string" || root.goal_brief.trim() === "")
  ) {
    throw new Error("ideas-curator promote action requires goal_brief");
  }

  return {
    picked_idea_id:
      typeof root.picked_idea_id === "string" ? root.picked_idea_id : null,
    fit_rationale: root.fit_rationale.trim(),
    recommended_action: root.recommended_action,
    goal_brief:
      typeof root.goal_brief === "string" ? root.goal_brief.trim() : undefined,
  };
}

function extractJsonObject(text: string): string | null {
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (fenced.length > 0) {
    return fenced[fenced.length - 1][1].trim();
  }

  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return null;
}

async function loadProviderForRole(
  sql: Sql,
  providerId: ProviderId,
  roleSlug: string,
): Promise<ChatProvider> {
  if (providerId === "openrouter") {
    const encryptionKey = process.env.ENCRYPTION_KEY || "";
    let openrouterApiKey = "";
    if (encryptionKey) {
      const creds = await loadCredentials(sql, {
        hiveId: "00000000-0000-0000-0000-000000000000",
        requiredKeys: ["OPENROUTER_API_KEY"],
        roleSlug,
        encryptionKey,
      });
      openrouterApiKey =
        (creds as unknown as Record<string, string>).OPENROUTER_API_KEY ?? "";
    }
    const provider = getChatProvider("openrouter", { openrouterApiKey });
    if (!provider) {
      throw new Error("ideas-curator could not initialize openrouter provider");
    }
    return provider;
  }

  const provider = getChatProvider(providerId);
  if (!provider) {
    throw new Error(`ideas-curator could not initialize provider '${providerId}'`);
  }
  return provider;
}

function resolveProvider(
  recommendedModel: string | null | undefined,
  adapterType: string | null | undefined,
): { provider: ProviderId; model: string } {
  const rawModel = recommendedModel?.trim() || "";
  if (rawModel.startsWith("ollama/")) {
    return { provider: "ollama", model: rawModel.slice("ollama/".length) };
  }
  if (rawModel.startsWith("openrouter/")) {
    return { provider: "openrouter", model: rawModel.slice("openrouter/".length) };
  }
  if (rawModel.startsWith("openai/") || rawModel.startsWith("anthropic/") || rawModel.startsWith("google/")) {
    return { provider: "openrouter", model: rawModel };
  }
  if (adapterType === "ollama") {
    return { provider: "ollama", model: rawModel || "qwen3.5:27b" };
  }
  return { provider: "openrouter", model: rawModel || "openai/gpt-4o-mini" };
}
