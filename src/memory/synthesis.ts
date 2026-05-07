import type { Sql } from "postgres";
import { callGenerationModel, type ModelCallerConfig, getDefaultConfig } from "./model-caller";

const MIN_WPS_FOR_SYNTHESIS = 5;

interface WorkProductForSynthesis {
  id: string;
  department: string | null;
  content: string;
  roleSlug: string;
}

export async function shouldRunSynthesis(sql: Sql, hiveId: string): Promise<boolean> {
  const [countRow] = await sql`
    SELECT COUNT(*)::int AS count FROM work_products
    WHERE hive_id = ${hiveId} AND synthesized = false
  `;
  const unsynthesized = countRow?.count ?? 0;

  if (unsynthesized >= MIN_WPS_FOR_SYNTHESIS) return true;

  // Time-based fallback: if any unsynthesized WPs exist and last synthesis was >24h ago
  if (unsynthesized > 0) {
    const [lastSynth] = await sql`
      SELECT MAX(created_at) AS last_synth FROM work_products
      WHERE hive_id = ${hiveId} AND synthesized = true
    `;
    if (!lastSynth?.last_synth) return true; // Never synthesized and there are unsynthesized WPs
    const hoursSinceLast = (Date.now() - new Date(lastSynth.last_synth as string).getTime()) / (1000 * 60 * 60);
    if (hoursSinceLast >= 24) return true;
  }

  return false;
}

export async function findUnsynthesizedWorkProducts(
  sql: Sql,
  hiveId: string,
): Promise<WorkProductForSynthesis[]> {
  const rows = await sql`
    SELECT id, department, content, role_slug
    FROM work_products
    WHERE hive_id = ${hiveId} AND synthesized = false
    ORDER BY created_at ASC
  `;
  return rows.map((r) => ({
    id: r.id as string,
    department: r.department as string | null,
    content: r.content as string,
    roleSlug: (r.role_slug ?? r["roleSlug"]) as string,
  }));
}

export function findCandidatePairs(
  wps: WorkProductForSynthesis[],
): [WorkProductForSynthesis, WorkProductForSynthesis][] {
  const pairs: [WorkProductForSynthesis, WorkProductForSynthesis][] = [];
  for (let i = 0; i < wps.length; i++) {
    for (let j = i + 1; j < wps.length; j++) {
      if (wps[i].department && wps[j].department && wps[i].department !== wps[j].department) {
        pairs.push([wps[i], wps[j]]);
      }
    }
  }
  return pairs.slice(0, 10);
}

function buildSynthesisPrompt(
  wp1: WorkProductForSynthesis,
  wp2: WorkProductForSynthesis,
): string {
  return `You are a hive intelligence analyst. Given two work products from different departments, identify any non-obvious connection, contradiction, opportunity, or risk.

## Work Product 1 (${wp1.department}, by ${wp1.roleSlug})
${wp1.content.slice(0, 1000)}

## Work Product 2 (${wp2.department}, by ${wp2.roleSlug})
${wp2.content.slice(0, 1000)}

## Instructions
If you find a genuine insight that neither department would have found alone, respond with ONLY this JSON:
{
  "hasInsight": true,
  "content": "the insight in one clear sentence",
  "connectionType": "causal|contradictory|reinforcing|opportunity|risk",
  "confidence": 0.0-1.0,
  "affectedDepartments": ["dept1", "dept2"]
}

If there is no meaningful cross-department connection, respond with:
{"hasInsight": false}

Be selective. Only report genuinely useful insights, not obvious observations.`;
}

interface SynthesisInsight {
  content: string;
  connectionType: string;
  confidence: number;
  affectedDepartments: string[];
  sourceWpIds: string[];
}

function parseSynthesisResponse(
  response: string,
  wp1Id: string,
  wp2Id: string,
): SynthesisInsight | null {
  let cleaned = response.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed.hasInsight) return null;
    return {
      content: parsed.content,
      connectionType: parsed.connectionType || "reinforcing",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      affectedDepartments: Array.isArray(parsed.affectedDepartments) ? parsed.affectedDepartments : [],
      sourceWpIds: [wp1Id, wp2Id],
    };
  } catch {
    return null;
  }
}

export interface SynthesisResult {
  workProductsProcessed: number;
  pairsAnalyzed: number;
  insightsCreated: number;
}

export async function runSynthesis(
  sql: Sql,
  hiveId: string,
  modelConfig: ModelCallerConfig = getDefaultConfig(),
): Promise<SynthesisResult> {
  const wps = await findUnsynthesizedWorkProducts(sql, hiveId);
  if (wps.length === 0) {
    return { workProductsProcessed: 0, pairsAnalyzed: 0, insightsCreated: 0 };
  }
  const pairs = findCandidatePairs(wps);
  let insightsCreated = 0;
  for (const [wp1, wp2] of pairs) {
    try {
      const prompt = buildSynthesisPrompt(wp1, wp2);
      const response = await callGenerationModel(prompt, modelConfig);
      const insight = parseSynthesisResponse(response, wp1.id, wp2.id);
      if (insight) {
        await sql`
          INSERT INTO insights (
            hive_id, content, connection_type, confidence,
            affected_departments, source_work_products,
            max_source_sensitivity, status, priority
          ) VALUES (
            ${hiveId},
            ${insight.content},
            ${insight.connectionType},
            ${insight.confidence},
            ${sql.json(insight.affectedDepartments)},
            ${sql.json(insight.sourceWpIds)},
            'internal',
            'new',
            ${insight.confidence >= 0.8 ? "high" : "medium"}
          )
        `;
        insightsCreated++;
      }
    } catch (err) {
      console.error("[synthesis] Error analyzing pair:", err);
    }
  }
  const wpIds = wps.map((wp) => wp.id);
  await sql`UPDATE work_products SET synthesized = true WHERE id = ANY(${wpIds})`;
  return { workProductsProcessed: wps.length, pairsAnalyzed: pairs.length, insightsCreated };
}
