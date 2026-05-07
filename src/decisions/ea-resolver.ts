import type { Sql } from "postgres";
import { runEa } from "../ea/native/runner";

/**
 * EA-first decision resolver.
 *
 * Every system-generated decision (doctor escalation, malformed diagnosis,
 * credential expiry, supervisor questions, etc.) is created in
 * `status='ea_review'`. The dispatcher hands them to this resolver, which
 * spawns a headless EA agent (claude-code CLI) with the decision context
 * + full shell + HiveWright API access. The EA either:
 *
 *   - resolves it autonomously (cancels orphan task, retries with a new
 *     role, asks the supervisor to re-plan, etc.) — decision goes to
 *     `resolved` with `owner_response='ea-decided: <reason>'`
 *
 *   - rewrites it into plain English and escalates to the owner — decision
 *     moves to `pending` with cleaned-up title + context, and the original
 *     technical context preserved as part of `ea_reasoning`
 *
 *   - punts back as `needs_more_info` — bumps `ea_attempts`; cap at 2.
 *
 * Designed so that the owner only ever sees decisions that genuinely
 * required their judgement, not technical noise.
 */

export interface EaResolverDecisionInput {
  decisionId: string;
  hiveId: string;
  goalId: string | null;
  taskId: string | null;
  title: string;
  context: string;
  recommendation: string | null;
  options?: unknown;
  priority: string;
  kind: string;
}

export interface EaResolverDecisionOption {
  key: string;
  label: string;
  consequence?: string;
  description?: string;
  response?: string;
  canonicalResponse?: string;
  canonical_response?: string;
}

export interface EaResolverResult {
  action: "auto_resolve" | "escalate_to_owner" | "needs_more_info";
  reasoning: string;
  // Only present when action='escalate_to_owner'
  ownerTitle?: string;
  ownerContext?: string;
  ownerRecommendation?: string;
  ownerPriority?: "urgent" | "normal" | "low";
  ownerOptions?: EaResolverDecisionOption[];
}

/** Max EA-resolution attempts before forcibly escalating. */
export const MAX_EA_ATTEMPTS = 2;

const RESOLVER_ROLE_MD = `# Executive Assistant — Decision Resolver

You are the Executive Assistant for the owner's hive. The owner is a
USER, not a developer — your job is to handle technical operational
decisions on his behalf so he never has to read raw error dumps or
make judgement calls about things you can decide yourself.

## Your job right now

A decision was created by the system that would, by default, ping the
owner. **Read it carefully and decide what to do.** You have full
shell access and can curl the local HiveWright API at
http://localhost:3002 to investigate (list tasks, fetch goal context,
check role library, etc.) and to take action (retry tasks, cancel
orphans, leave comments on goals, etc.).
Every local API request must include \`Authorization: Bearer $INTERNAL_SERVICE_TOKEN\`.

## Decision rules

- **Default to acting**, not escalating. The whole point of being the EA
  is that the owner shouldn't see operational/technical decisions.
- Escalate to the owner ONLY when the choice is a real value judgement
  he must make — spending money, exposing customer data, killing a
  goal he asked for, picking between strategies that have meaningful
  business consequences.
- Never escalate to the owner because something is "complicated" or
  "uncertain" — that's exactly the kind of work you exist to absorb.
- If you genuinely cannot decide, prefer \`needs_more_info\` (we'll
  retry once with fresh context) over escalating.
- When you do escalate, the owner should see plain English. Strip out
  JSON, stack traces, FK constraint names, internal IDs.
- If escalation presents real named alternatives (runtime/auth/product/process
  paths), include structured ownerOptions[]. Each option needs a stable key,
  a human-readable label, a consequence/tradeoff, and the canonical response
  it maps to where applicable. Do not flatten named alternatives into
  ownerContext or ownerRecommendation only. Simple approve/reject decisions
  should stay simple and omit ownerOptions.
- For route-choice escalations involving auth, runtime, third-party services,
  connectors, or product forks, rewrite incomplete option sets before
  escalating. Mentally enumerate: (a) buy/add a new credential/key/account/
  subscription, (b) reuse an existing credential, connector, infrastructure
  path, or subscription the hive already has (check the credentials table,
  env, Codex auth, Claude Code auth, and known paid subscriptions), (c) switch
  to a different already-installed connector/path, and (d) defer. Include any
  technically feasible paths in ownerOptions[]. Hiding the "reuse existing
  credential/subscription/infrastructure" path while listing "add a new key"
  is a known anti-pattern.
- Example: if the raw decision says image generation needs a new OpenAI API
  key, but existing OpenAI Codex subscription auth is a plausible route, add an
  ownerOptions[] entry such as "Use existing Codex subscription auth" before
  asking the owner to provide a new API key.
- Example multi-way escalation for Gemini CLI auth/runtime:
  ownerOptions: [
    {
      key: "api-key-runtime",
      label: "Use Gemini API key runtime",
      consequence: "Fast to automate but requires storing a credential.",
      response: "approved"
    },
    {
      key: "oauth-user-login",
      label: "Use OAuth user login",
      consequence: "Owner signs in locally; better fit when API key storage is not acceptable.",
      response: "approved"
    },
    {
      key: "gca-login",
      label: "Use GCA login",
      consequence: "Matches the reference incident path; selecting this directly should continue that route without using Discuss.",
      response: "approved"
    },
    {
      key: "defer-gemini-adapter",
      label: "Defer Gemini adapter work",
      consequence: "Keeps the goal parked until a better auth path exists.",
      response: "rejected"
    }
  ]

## Available tools (via curl)

\`\`\`bash
# Inspect the failing task / its history
curl -sS http://localhost:3002/api/tasks/<task-id> \\
  -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN'
curl -sS "http://localhost:3002/api/tasks?goalId=<goal-id>" \\
  -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN'

# Inspect the goal
curl -sS http://localhost:3002/api/goals/<goal-id> \\
  -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN'

# Cancel a task you decide is unwanted
curl -sS -X PATCH http://localhost:3002/api/tasks/<task-id> \\
  -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN' \\
  -H 'Content-Type: application/json' \\
  -d '{"status":"cancelled"}'

# Retry a failed task with a new role / new brief
curl -sS -X PATCH http://localhost:3002/api/tasks/<task-id> \\
  -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN' \\
  -H 'Content-Type: application/json' \\
  -d '{"status":"pending","assignedTo":"<role-slug>"}'

# Add a comment to a goal (wakes the supervisor on its next pickup)
curl -sS -X POST http://localhost:3002/api/goals/<goal-id>/comments \\
  -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN' \\
  -H 'Content-Type: application/json' \\
  -d '{"body":"<your message to the supervisor>"}'

# Look up valid role slugs
curl -sS http://localhost:3002/api/roles \\
  -H 'Authorization: Bearer $INTERNAL_SERVICE_TOKEN' | jq '.data[].slug'
\`\`\`

**Do NOT** curl \`/api/decisions/<id>/respond\` yourself — the dispatcher
closes the decision row based on your structured output below. Your job
here is to take side-effect actions (cancel tasks, retry, comment on
goals, leave hive memory) and then tell us what to do with the
decision via the JSON block.

## Output contract — REQUIRED

After investigating + taking any action, your response MUST end with
a fenced \`\`\`json\`\`\` block matching this schema:

\`\`\`json
{
  "action": "auto_resolve" | "escalate_to_owner" | "needs_more_info",
  "reasoning": "Short plain-English summary of what you checked and why you chose this action",
  "ownerTitle":         "ONLY if action=escalate_to_owner — short owner-friendly title",
  "ownerContext":       "ONLY if action=escalate_to_owner — owner-friendly explanation of the choice",
  "ownerRecommendation":"ONLY if action=escalate_to_owner — your suggestion for what to do",
  "ownerPriority":      "ONLY if action=escalate_to_owner — 'urgent' | 'normal' | 'low'",
  "ownerOptions":       "OPTIONAL if action=escalate_to_owner — array of named alternatives with key, label, consequence/description, and response/canonicalResponse"
}
\`\`\`

If the JSON block is missing or malformed, the dispatcher will retry
once and then forcibly escalate the decision unchanged.
`;

export function buildResolverPrompt(decision: EaResolverDecisionInput): string {
  return `${RESOLVER_ROLE_MD}

---

## Decision to resolve

- **Decision ID:** ${decision.decisionId}
- **Hive ID:** ${decision.hiveId}
- **Goal ID:** ${decision.goalId ?? "(none)"}
- **Task ID:** ${decision.taskId ?? "(none)"}
- **Original priority:** ${decision.priority}
- **Original kind:** ${decision.kind}

### Title (raw, system-generated)
${decision.title}

### Context (raw, system-generated)
${decision.context}

### Recommendation (raw, system-generated)
${decision.recommendation ?? "(none)"}

### Options (raw, system-generated)
${decision.options === undefined ? "(none)" : JSON.stringify(decision.options, null, 2)}

---

Investigate, act if you can, then emit your structured decision.
`;
}

const JSON_FENCE_REGEX = /```json\s*\n([\s\S]*?)\n```/g;

/**
 * Pull the LAST fenced ```json block out of the EA's text and parse it.
 * If the runtime returns a bare JSON object instead of markdown, accept that
 * too and let the same strict schema validation below decide whether it is
 * usable.
 * Mirrors parseDoctorDiagnosis — supervisors and doctors share this
 * structured-output convention.
 */
export function parseEaResolverOutput(
  text: string,
): { ok: true; result: EaResolverResult } | { ok: false; reason: string } {
  let jsonText: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = JSON_FENCE_REGEX.exec(text)) !== null) {
    jsonText = match[1];
  }
  if (!jsonText) {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      jsonText = trimmed;
    }
  }
  if (!jsonText) {
    return { ok: false, reason: "no fenced ```json``` block or plain JSON object found in EA output" };
  }

  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, reason: `JSON parse failed: ${(err as Error).message}` };
  }
  if (!obj || typeof obj !== "object") {
    return { ok: false, reason: "JSON block was not an object" };
  }
  const o = obj as Record<string, unknown>;
  const action = o.action;
  if (action !== "auto_resolve" && action !== "escalate_to_owner" && action !== "needs_more_info") {
    return { ok: false, reason: `unknown action: ${String(action)}` };
  }
  if (typeof o.reasoning !== "string" || !o.reasoning.trim()) {
    return { ok: false, reason: "reasoning is required" };
  }
  if (action === "escalate_to_owner") {
    if (typeof o.ownerTitle !== "string" || !o.ownerTitle.trim()) {
      return { ok: false, reason: "escalate_to_owner requires ownerTitle" };
    }
    if (typeof o.ownerContext !== "string" || !o.ownerContext.trim()) {
      return { ok: false, reason: "escalate_to_owner requires ownerContext" };
    }
    if (o.ownerOptions !== undefined) {
      const optionsResult = parseOwnerOptions(o.ownerOptions);
      if (!optionsResult.ok) return optionsResult;
    }
  }
  const ownerOptions = o.ownerOptions === undefined ? undefined : parseOwnerOptions(o.ownerOptions);
  return {
    ok: true,
    result: {
      action,
      reasoning: o.reasoning,
      ownerTitle: typeof o.ownerTitle === "string" ? o.ownerTitle : undefined,
      ownerContext: typeof o.ownerContext === "string" ? o.ownerContext : undefined,
      ownerRecommendation:
        typeof o.ownerRecommendation === "string" ? o.ownerRecommendation : undefined,
      ownerPriority:
        o.ownerPriority === "urgent" || o.ownerPriority === "normal" || o.ownerPriority === "low"
          ? o.ownerPriority
          : undefined,
      ownerOptions:
        ownerOptions && ownerOptions.ok ? ownerOptions.options : undefined,
    },
  };
}

function parseOwnerOptions(
  raw: unknown,
): { ok: true; options: EaResolverDecisionOption[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: "ownerOptions must be an array when present" };
  const options: EaResolverDecisionOption[] = [];
  for (const [idx, value] of raw.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, reason: `ownerOptions[${idx}] must be an object` };
    }
    const record = value as Record<string, unknown>;
    if (typeof record.key !== "string" || !record.key.trim()) {
      return { ok: false, reason: `ownerOptions[${idx}].key is required` };
    }
    if (typeof record.label !== "string" || !record.label.trim()) {
      return { ok: false, reason: `ownerOptions[${idx}].label is required` };
    }
    for (const field of ["consequence", "description", "response", "canonicalResponse", "canonical_response"]) {
      if (record[field] !== undefined && typeof record[field] !== "string") {
        return { ok: false, reason: `ownerOptions[${idx}].${field} must be a string when present` };
      }
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
  return { ok: true, options };
}

/**
 * Run the EA resolver on a single decision row. Pure function over the
 * input — does NOT mutate the decision row itself; the caller decides
 * what to do with the parsed result.
 *
 * Times out after 5 minutes. Failures (timeout, exit nonzero, malformed
 * JSON) are returned as `{ ok: false, ... }` so the dispatcher can decide
 * whether to retry or forcibly escalate.
 */
export async function resolveDecisionViaEa(
  _sql: Sql,
  decision: EaResolverDecisionInput,
): Promise<
  | { ok: true; result: EaResolverResult; rawText: string }
  | { ok: false; reason: string; rawText: string }
> {
  const prompt = buildResolverPrompt(decision);
  const ea = await runEa(prompt, {
    timeoutMs: 5 * 60_000,
  });

  if (!ea.success) {
    return { ok: false, reason: ea.error ?? "EA runner failed", rawText: ea.text };
  }

  const parsed = parseEaResolverOutput(ea.text);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, rawText: ea.text };
  }
  return { ok: true, result: parsed.result, rawText: ea.text };
}

/**
 * Phrases in a decision title/context/option that signal the gate explicitly
 * requires the owner — not the EA — to act. When matched, `applyEaResolution`
 * forces an `escalate_to_owner` even if the EA returned `auto_resolve`.
 *
 * Defense-in-depth on the EA prompt. The prompt already says "escalate when
 * owner judgement is required," but the EA can still rationalise its way to
 * `auto_resolve` on a decision whose acceptance criteria literally name the
 * owner (incident: decision f03b884d).
 */
const OWNER_APPROVAL_PATTERNS: readonly RegExp[] = [
  /\bowner[\s-]*(?:approval|approve[sd]?|sign[\s-]?off|review|judgement|judgment|authoriz(?:e|ed|ation)|acceptance)\b/i,
  /\bowner[-\s]authored\b/i,
  /\brequires?\s+(?:the\s+)?owner\b/i,
  /\bowner\s+(?:must|needs to|has to|should)\s+(?:approve|review|sign|decide|authoris|authoriz|confirm|accept)/i,
  /\bgated?\s+by\s+(?:the\s+)?owner\b/i,
  /\bonly\s+(?:the\s+)?owner\s+can\s+(?:approve|sign|decide|authoris|authoriz|confirm|accept)/i,
  /\baw?ait(?:s|ing)?\s+owner\b/i,
];

export function decisionTextRequiresOwnerApproval(
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  return OWNER_APPROVAL_PATTERNS.some((re) => re.test(text));
}

export type DecisionGuardSnapshot = {
  title?: string | null;
  context?: string | null;
  recommendation?: string | null;
  options?: unknown;
};

export function decisionRequiresOwnerApproval(
  decision: DecisionGuardSnapshot,
): boolean {
  if (decisionTextRequiresOwnerApproval(decision.title)) return true;
  if (decisionTextRequiresOwnerApproval(decision.context)) return true;
  if (decisionTextRequiresOwnerApproval(decision.recommendation)) return true;
  const rawOptions = decision.options;
  const opts: unknown[] = Array.isArray(rawOptions)
    ? rawOptions
    : Array.isArray((rawOptions as { options?: unknown[] } | null)?.options)
      ? ((rawOptions as { options: unknown[] }).options)
      : [];
  for (const opt of opts) {
    if (!opt || typeof opt !== "object") continue;
    const record = opt as Record<string, unknown>;
    for (const field of ["label", "description", "consequence"] as const) {
      const value = record[field];
      if (typeof value === "string" && decisionTextRequiresOwnerApproval(value)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Apply the EA's structured decision to the decisions row. Idempotent and
 * non-destructive — only writes the columns named.
 */
export async function applyEaResolution(
  sql: Sql,
  decisionId: string,
  result: EaResolverResult,
): Promise<void> {
  if (result.action === "auto_resolve") {
    const [snapshot] = await sql<{
      title: string;
      context: string;
      recommendation: string | null;
      options: unknown;
    }[]>`
      SELECT title, context, recommendation, options
      FROM decisions
      WHERE id = ${decisionId}
    `;
    if (snapshot && decisionRequiresOwnerApproval(snapshot)) {
      result = {
        action: "escalate_to_owner",
        reasoning:
          `Owner-approval gate detected in decision text — EA cannot auto-resolve. ` +
          `Original EA reasoning: ${result.reasoning}`,
        ownerTitle: snapshot.title,
        ownerContext: snapshot.context,
        ownerRecommendation: snapshot.recommendation ?? undefined,
        ownerPriority: "normal",
      };
    }
  }

  const eaSummary = `ea-decided: ${result.reasoning.slice(0, 500)}`;

  if (result.action === "auto_resolve") {
    // The EA already took whatever curl-action it needed; we just close
    // the decision so it leaves the owner-facing queue.
    await sql.begin(async (tx) => {
      await tx`
      UPDATE decisions
      SET status = 'resolved',
          owner_response = ${eaSummary},
          ea_reasoning = ${result.reasoning},
          ea_decided_at = NOW(),
          ea_attempts = ea_attempts + 1,
          resolved_at = NOW(),
          resolved_by = 'ea-resolver'
      WHERE id = ${decisionId}
    `;
      await tx`
        INSERT INTO decision_messages (decision_id, sender, content)
        VALUES (
          ${decisionId},
          'ea-resolver',
          ${`EA auto-resolved after discussion/review: ${result.reasoning}`}
        )
      `;
    });
    return;
  }

  if (result.action === "escalate_to_owner") {
    // Replace title/context with the EA's owner-friendly version. Save
    // ea_reasoning so the owner can drill in if they want to see what
    // the EA concluded.
    const newTitle = result.ownerTitle!;
    const newContext = result.ownerContext!;
    const newRecommendation = result.ownerRecommendation ?? null;
    const newPriority = result.ownerPriority ?? "normal";
    if (result.ownerOptions !== undefined) {
      await sql`
        UPDATE decisions
        SET status = 'pending',
            title = ${newTitle},
            context = ${newContext},
            recommendation = ${newRecommendation},
            options = ${sql.json(result.ownerOptions as unknown as Parameters<typeof sql.json>[0])},
            priority = ${newPriority},
            ea_reasoning = ${result.reasoning},
            ea_decided_at = NOW(),
            ea_attempts = ea_attempts + 1
        WHERE id = ${decisionId}
      `;
      return;
    }
    await sql`
      UPDATE decisions
      SET status = 'pending',
          title = ${newTitle},
          context = ${newContext},
          recommendation = ${newRecommendation},
          priority = ${newPriority},
          ea_reasoning = ${result.reasoning},
          ea_decided_at = NOW(),
          ea_attempts = ea_attempts + 1
      WHERE id = ${decisionId}
    `;
    return;
  }

  // needs_more_info — bump attempts but stay in ea_review for one more pass.
  await sql`
    UPDATE decisions
    SET ea_reasoning = ${result.reasoning},
        ea_decided_at = NOW(),
        ea_attempts = ea_attempts + 1
    WHERE id = ${decisionId}
  `;
}

/**
 * Forcibly move a decision out of `ea_review` after MAX_EA_ATTEMPTS
 * exhausted retries (malformed output / EA crashes / repeated needs_more_info).
 * The owner sees the original title/context untouched + a banner noting
 * that the EA could not handle it.
 */
export async function forceEscalateAfterEaFailure(
  sql: Sql,
  decisionId: string,
  reason: string,
): Promise<void> {
  await sql`
    UPDATE decisions
    SET status = 'pending',
        ea_reasoning = ${`EA could not autonomously resolve this after ${MAX_EA_ATTEMPTS} attempts: ${reason}`},
        ea_decided_at = NOW()
    WHERE id = ${decisionId}
  `;
}
