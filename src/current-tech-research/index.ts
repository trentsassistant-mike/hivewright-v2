import type { Sql } from "postgres";
import { getGoalPlan, upsertGoalPlan } from "@/goals/goal-documents";
export {
  buildEvaluatedReleaseFindingKey,
  normalizeFindingKey,
  recordEvaluatedReleaseFinding,
} from "./evaluated-release-registry";
export type {
  EvaluatedReleaseDisposition,
  EvaluatedReleaseIdentity,
  EvaluatedReleaseMaterialSignature,
  EvaluatedReleaseRecord,
  EvaluatedReleaseRegistryInput,
  EvaluatedReleaseRegistryResult,
} from "./evaluated-release-registry";

export const CURRENT_TECH_RESEARCH_KIND = "current-tech-research-daily";
export const CURRENT_TECH_RESEARCH_TITLE = "Current tech research";
export const CURRENT_TECH_RESEARCH_SCHEDULE_TITLE = "Current tech research daily cycle";
export const CURRENT_TECH_RESEARCH_PLAN_VERSION = "current-tech-research-plan-v1";
export const CURRENT_TECH_RESEARCH_COMMENT_AUTHOR = "scheduler:current-tech-research";
export const CURRENT_TECH_RESEARCH_TIME_ZONE = "Australia/Melbourne";

export interface CurrentTechResearchTrigger {
  kind: "schedule";
  scheduleId: string;
}

export interface RunCurrentTechResearchDailyOptions {
  hiveId: string;
  trigger: CurrentTechResearchTrigger;
  now?: Date;
}

export interface RunCurrentTechResearchDailyResult {
  goalId: string;
  cycleDate: string;
  goalCreated: boolean;
  planUpdated: boolean;
  kickoffCreated: boolean;
  duplicate: boolean;
}

interface GoalRow {
  id: string;
}

function cycleDateInMelbourne(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: CURRENT_TECH_RESEARCH_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function kickoffMarker(cycleDate: string): string {
  return `<!-- current-tech-research-cycle:${cycleDate} -->`;
}

export function buildHiveWrightUpdatedNotificationMessage(input: {
  shippedChange: string;
  newCapability: string;
  caveats?: string;
}): { title: "HiveWright Updated"; message: string; priority: "normal"; source: string } {
  const caveats = input.caveats?.trim();
  return {
    title: "HiveWright Updated",
    message: [
      input.shippedChange.trim(),
      `HiveWright can now ${input.newCapability.trim()}.`,
      caveats ? `Caveats: ${caveats}` : null,
    ].filter(Boolean).join("\n\n"),
    priority: "normal",
    source: "current-tech-research",
  };
}

export function buildCurrentTechResearchPlan(): string {
  return `# Current Tech Research Recurring Workflow

Plan marker: ${CURRENT_TECH_RESEARCH_PLAN_VERSION}

## Cadence And Kickoff

- A schedule with \`task_template.kind = ${CURRENT_TECH_RESEARCH_KIND}\` runs daily at 08:30 in the dispatcher host timezone.
- Production HiveWright hosts are configured for ${CURRENT_TECH_RESEARCH_TIME_ZONE}; if that changes, replace this with a timezone-aware scheduler before changing cadence.
- Each run creates one dated \`goal_comments\` kickoff marker. Existing markers for the same ${CURRENT_TECH_RESEARCH_TIME_ZONE} date block duplicate daily cycles.

## Traceability

Before automating a rubric dimension or guardrail, use \`docs/research/current-tech-research-traceability-matrix.md\`.

## Evaluated Release Registry

Use \`current_tech_evaluated_releases\` through the current-tech workflow only to record one evaluated row per normalized \`finding_key\`. Build that key from stable release identity: vendor, product, version or \`unversioned\`, release date, and source URL using \`buildEvaluatedReleaseFindingKey\`. Repeated findings within seven days reuse the prior disposition and linked task/decision references unless the material-change test passes.

Material change means at least one of: changed affected local version/provider, new vendor patch, breaking change, pricing change, deprecation, security update, owner approval, specialist review result, or narrower remediation after a failed prior task.

Security/privacy: registry evidence stores source URLs, release metadata, disposition rationale, and linked internal IDs only. Do not store secret values, raw credentials, private tokens, or full owner transcripts.

Disable path: ignore registry reads/writes in the current-tech workflow and fall back to the dated kickoff marker idempotency. Because the registry is isolated to this workflow, disabling reads does not affect provider routing, credentials, billing, deployment, or frontend behavior.

All active rubric dimensions must appear in the usefulness report:

| Dimension | Treatment | Seam |
| --- | --- | --- |
| Mission fit | Analyst judgement with score threshold after scoring | work_products, tasks |
| User/product impact | Analyst judgement | work_products, tasks |
| Implementation effort | Judgement plus deterministic task scope checks | tasks, work_products |
| Security/privacy risk | Deterministic block plus analyst score | decisions, tasks, work_products |
| Maturity/reliability | Evidence-backed judgement | work_products |
| Cost | Deterministic owner-decision trigger plus analyst score | decisions, work_products |
| Licensing/legal fit | Deterministic block plus analyst score | decisions, work_products |
| Operational complexity | Judgement plus task acceptance criteria | tasks, work_products |
| Reversibility | Deterministic implementation-brief requirement | tasks, work_products |
| Time-to-value | Judgement plus task scoping | tasks, work_products |

All active guardrails must be applied:

| Guardrail | Treatment | Required outcome |
| --- | --- | --- |
| Unsafe changes | Deterministic block | Create owner decision or security/privacy review before implementation |
| Duplicative changes | Analyst overlap check plus measurable-benefit requirement | Document overlap before implementation |
| Speculative changes | Deterministic block when evidence, docs, APIs, pricing, terms, observed need, or acceptance test is missing | Defer/watchlist with revisit criteria |
| Expensive changes | Deterministic owner-decision trigger for unclear, uncapped, paid-seat, committed-spend, infrastructure, or budget-control-dependent cost | Create owner decision with cost controls and alternatives |

## Daily Sprint Chain

Use settled sprints to preserve ordering. Do not create research, analysis, usefulness, and implementation tasks as one simultaneous batch.

1. Research: create one \`research-analyst\` task for newest tech releases in the scan window. Require the canonical daily research brief/output contract below. The executor must stop at Research and must not perform synthesis, usefulness scoring, implementation routing, QA, owner decisions, or notification.
2. Synthesis/analysis: after the research task settles, create one \`intelligence-analyst\` or \`data-analyst\` task that consumes the canonical research output contract, summarizes what changed, evidence quality, confidence, and conflicts, then prepares the evidence for usefulness assessment.
3. HiveWright usefulness assessment: after synthesis settles, create one \`performance-analyst\` task that scores every active rubric dimension, applies every guardrail, and recommends implement now, owner decision, defer/watchlist, or reject.
4. Implementation/decision/deferral:
   - Create implementation tasks only for bounded changes that pass the implement-now gate.
   - Create owner decisions for cost, credentials, licensing, security/privacy, vendor/provider, product-direction, owner-communication, or autonomy tradeoffs.
   - Create watchlist/deferral notes for promising discoveries blocked by cost, credentials, licensing, security/privacy, missing docs/API/pricing, unavailable access, or owner judgement.
5. QA: do not manually create QA child tasks. Set \`qaRequired: true\` on code or customer-facing implementation tasks and let the dispatcher QA router create the QA child task.
6. Owner notification: after an implementation passes QA and ships, send an owner notification with title \`HiveWright Updated\` and a body explaining what changed and what HiveWright can now do. If no notification connector is configured, create a goal comment with the same title/body and document that fallback in the daily work product.

## Canonical Daily Research Brief And Output Contract

Every generated daily Research-stage task brief must require one work product of kind \`daily-current-tech-research-contract\`. Downstream synthesis must consume that work product as its only source of same-cycle research evidence before any usefulness scoring or implementation routing.

Research executor boundary:

- Stop at Research. Do not synthesize findings across items.
- Do not score usefulness, rank candidates, create implementation tasks, create owner decisions, perform QA, choose owner-notification content, or notify the owner.
- Use \`action_class_candidate\` only as an unscored placeholder for downstream stages. Allowed placeholder values are \`unknown\`, \`candidate\`, \`needs-primary-source\`, \`likely-duplicate\`, or \`excluded\`.

The Research task brief and output must include these top-level fields:

- \`cycle_date\`: ${CURRENT_TECH_RESEARCH_TIME_ZONE} date for the daily cycle.
- \`cycle_timezone\`: ${CURRENT_TECH_RESEARCH_TIME_ZONE}.
- \`scan_window\`: start timestamp, end timestamp, scan-window hours, and any missed-run expansion reason.
- \`volume_summary\`: count of sources checked, findings recorded, duplicate candidates, exclusions, and source gaps.
- \`exclusions\`: items intentionally excluded, with reason and source URL when available.
- \`no_action_notes\`: releases or source leads that need no downstream action, with confirmed rationale.
- \`traceability_matrix_handoff\`: traceability-matrix rows, seams, and guardrails that downstream synthesis/usefulness should inspect.
- \`rubric_handoff\`: usefulness rubric dimensions that may need scoring later, without assigning scores in Research.
- \`handoff_notes\`: concise notes for synthesis, including conflicts, evidence gaps, and items needing duplicate-registry review. This is a handoff only, not a routing recommendation.

Each finding in the output must include:

- \`finding_key\`: normalized vendor/product/version-or-unversioned/release-date/source key when available.
- \`source_urls\`: one or more URLs.
- \`publication_or_release_dates\`: publication, release, changelog, advisory, or observed dates.
- \`source_type\`: official release note, vendor documentation, security advisory, GitHub release, changelog, pricing/terms page, status page, reputable secondary source, or community discovery lead.
- \`confidence\`: high, medium, or low, based only on evidence quality.
- \`evidence_quality\`: primary-source, mixed-source, secondary-only, or unverified-lead.
- \`verified_facts\`: bullet facts verified from cited sources; separate from interpretation.
- \`interpretation\`: one concise interpretation or uncertainty note, kept separate from verified facts.
- \`hivewright_relevance_hypothesis\`: one concise hypothesis linking the facts to a HiveWright surface or operational concern.
- \`duplicate_check\`: checked registry/source history, prior reference if found, result, and whether material-change evidence exists.
- \`duplicate_check_result\`: first-seen, reuse-prior-closure, material-change, source-gap, or not-checked with reason.
- \`action_class_candidate\`: unscored placeholder for downstream synthesis/usefulness stages; not a disposition.

Mandatory Research-stage final section:

\`\`\`markdown
## Final Step - Commit

Before reporting this task complete, run:
1. \`git status\` to see what changed.
2. \`git add <specific files changed for this task>\` and do not use \`git add -A\`.
3. \`git commit -m "research(current-tech): daily scan <YYYY-MM-DD>"\`.
4. Confirm \`git status\` is clean for the files touched by this task.
\`\`\`

## Implementation Task Brief Contract

Every generated implementation task brief must include:

- \`qaRequired: true\` for code or customer-facing changes.
- Concrete acceptance criteria that can fail clearly.
- Evidence links from the research and usefulness work products.
- Files/modules likely to change, or a discovery step if unknown.
- Security/privacy checks where data, auth, tools, providers, credentials, or external services are involved.
- Rollback or disablement path.
- Mandatory final section:

\`\`\`markdown
## Final Step - Commit

Before reporting this task complete, run:
1. \`git status\` to see what changed.
2. \`git add <specific files changed for this task>\` and do not use \`git add -A\`.
3. \`git commit -m "<clear conventional commit message>"\`.
4. Confirm \`git status\` is clean for the files touched by this task.
\`\`\`

## Source And Rubric Inputs

- Source strategy: \`docs/research/2026-04-28-daily-tech-release-source-strategy.md\`.
- Usefulness rubric: \`docs/research/tech-release-usefulness-rubric.md\`.
- Architecture map: \`docs/architecture/current-tech-research-workflow-map.md\`.
- Traceability matrix: \`docs/research/current-tech-research-traceability-matrix.md\`.
`;
}

function buildKickoffBody(cycleDate: string, scheduleId: string): string {
  return `${kickoffMarker(cycleDate)}

Daily Current Tech Research kickoff for ${cycleDate} (${CURRENT_TECH_RESEARCH_TIME_ZONE}).

Supervisor instructions:
- Start or continue the ordered daily chain: research -> synthesis/analysis -> HiveWright usefulness assessment -> implementation/decision/deferral -> QA -> owner notification.
- Use the plan document and traceability matrix before applying rubric logic.
- Prevent duplicate work by treating this kickoff marker as the only daily cycle signal for this date.

Trigger: schedule ${scheduleId}`;
}

async function findOrCreateGoal(
  sql: Sql,
  hiveId: string,
): Promise<{ goalId: string; created: boolean }> {
  const [existing] = await sql<GoalRow[]>`
    SELECT id
    FROM goals
    WHERE hive_id = ${hiveId}::uuid
      AND title = ${CURRENT_TECH_RESEARCH_TITLE}
      AND status = 'active'
      AND archived_at IS NULL
    ORDER BY created_at ASC
    LIMIT 1
  `;
  if (existing) {
    return { goalId: existing.id, created: false };
  }

  const [goal] = await sql<GoalRow[]>`
    INSERT INTO goals (hive_id, title, description, status)
    VALUES (
      ${hiveId}::uuid,
      ${CURRENT_TECH_RESEARCH_TITLE},
      'Recurring daily workflow that researches new technology releases and promotes useful HiveWright improvements through analysis, decisions, implementation, QA, and owner notification.',
      'active'
    )
    RETURNING id
  `;
  await sql`SELECT pg_notify('new_goal', ${goal.id})`;
  return { goalId: goal.id, created: true };
}

async function ensurePlan(sql: Sql, goalId: string): Promise<boolean> {
  const existing = await getGoalPlan(sql, goalId);
  if (existing?.body.includes(CURRENT_TECH_RESEARCH_PLAN_VERSION)) {
    return false;
  }

  await upsertGoalPlan(sql, goalId, {
    title: "Current Tech Research Recurring Workflow",
    body: buildCurrentTechResearchPlan(),
    createdBy: "current-tech-research-runtime",
  });
  return true;
}

export async function runCurrentTechResearchDaily(
  sql: Sql,
  options: RunCurrentTechResearchDailyOptions,
): Promise<RunCurrentTechResearchDailyResult> {
  const now = options.now ?? new Date();
  const cycleDate = cycleDateInMelbourne(now);
  const marker = kickoffMarker(cycleDate);
  const { goalId, created: goalCreated } = await findOrCreateGoal(sql, options.hiveId);
  const planUpdated = await ensurePlan(sql, goalId);

  const [existingKickoff] = await sql<{ id: string }[]>`
    SELECT id
    FROM goal_comments
    WHERE goal_id = ${goalId}::uuid
      AND created_by = ${CURRENT_TECH_RESEARCH_COMMENT_AUTHOR}
      AND body LIKE ${`${marker}%`}
    LIMIT 1
  `;
  if (existingKickoff) {
    return {
      goalId,
      cycleDate,
      goalCreated,
      planUpdated,
      kickoffCreated: false,
      duplicate: true,
    };
  }

  const [comment] = await sql<{ id: string }[]>`
    INSERT INTO goal_comments (goal_id, body, created_by)
    VALUES (
      ${goalId}::uuid,
      ${buildKickoffBody(cycleDate, options.trigger.scheduleId)},
      ${CURRENT_TECH_RESEARCH_COMMENT_AUTHOR}
    )
    RETURNING id
  `;
  await sql`SELECT pg_notify('new_goal_comment', ${comment.id})`;

  return {
    goalId,
    cycleDate,
    goalCreated,
    planUpdated,
    kickoffCreated: true,
    duplicate: false,
  };
}
