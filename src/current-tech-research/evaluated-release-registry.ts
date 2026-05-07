import type { Sql } from "postgres";

export type EvaluatedReleaseDisposition =
  | "implement"
  | "owner_decision"
  | "specialist_review"
  | "watchlist"
  | "terminal_no_action"
  | "rejected";

export interface EvaluatedReleaseMaterialSignature {
  affectedLocalVersion?: string | null;
  provider?: string | null;
  vendorPatch?: string | null;
  breakingChange?: string | null;
  pricingChange?: string | null;
  deprecation?: string | null;
  securityUpdate?: string | null;
  ownerApprovalId?: string | null;
  specialistReviewResult?: string | null;
  remediationScope?: string | null;
}

export interface EvaluatedReleaseIdentity {
  vendor: string;
  product: string;
  version?: string | null;
  releaseDate: string;
  sourceUrl: string;
}

export interface EvaluatedReleaseRegistryInput {
  hiveId: string;
  findingKey: string;
  sourceUrl: string;
  sourceDate: string;
  cycleDate: string;
  disposition: EvaluatedReleaseDisposition;
  confidence: number;
  terminalRationale?: string | null;
  nextTrigger?: string | null;
  linkedTaskIds?: string[];
  linkedDecisionIds?: string[];
  materialSignature?: EvaluatedReleaseMaterialSignature;
}

export interface EvaluatedReleaseRecord {
  id: string;
  hiveId: string;
  findingKey: string;
  sourceUrl: string;
  sourceDate: string;
  firstSeenCycleDate: string;
  lastSeenCycleDate: string;
  disposition: EvaluatedReleaseDisposition;
  confidence: number;
  terminalRationale: string | null;
  nextTrigger: string | null;
  linkedTaskIds: string[];
  linkedDecisionIds: string[];
  materialSignature: EvaluatedReleaseMaterialSignature;
  lastMaterialChangeReason: string | null;
}

export interface EvaluatedReleaseRegistryResult {
  record: EvaluatedReleaseRecord;
  action: "created" | "reused" | "material_change";
  suppressDuplicateWork: boolean;
  materialChangeReasons: string[];
}

interface EvaluatedReleaseRow {
  id: string;
  hive_id: string;
  finding_key: string;
  source_url: string;
  source_date: string | Date;
  first_seen_cycle_date: string | Date;
  last_seen_cycle_date: string | Date;
  disposition: EvaluatedReleaseDisposition;
  confidence: string | number;
  terminal_rationale: string | null;
  next_trigger: string | null;
  linked_task_ids: string[];
  linked_decision_ids: string[];
  material_signature: EvaluatedReleaseMaterialSignature;
  last_material_change_reason: string | null;
}

const RECENT_REPEAT_WINDOW_DAYS = 7;

const MATERIAL_CHANGE_LABELS: Record<keyof EvaluatedReleaseMaterialSignature, string> = {
  affectedLocalVersion: "changed affected local version",
  provider: "changed provider",
  vendorPatch: "new vendor patch",
  breakingChange: "new breaking change",
  pricingChange: "new pricing change",
  deprecation: "new deprecation",
  securityUpdate: "new security update",
  ownerApprovalId: "owner approval",
  specialistReviewResult: "specialist review result",
  remediationScope: "narrower remediation after prior failure",
};

export function normalizeFindingKey(findingKey: string): string {
  return findingKey
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255);
}

function sourceKey(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    return `${url.hostname}${url.pathname}`.replace(/\/+$/g, "");
  } catch {
    return sourceUrl;
  }
}

export function buildEvaluatedReleaseFindingKey(identity: EvaluatedReleaseIdentity): string {
  return normalizeFindingKey([
    identity.vendor,
    identity.product,
    identity.version?.trim() || "unversioned",
    identity.releaseDate,
    sourceKey(identity.sourceUrl),
  ].join(" "));
}

function isoDate(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return value.slice(0, 10);
}

function daysBetween(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  return Math.floor((end - start) / 86_400_000);
}

function cleanSignature(
  signature: EvaluatedReleaseMaterialSignature | undefined,
): EvaluatedReleaseMaterialSignature {
  const cleaned: EvaluatedReleaseMaterialSignature = {};
  for (const key of Object.keys(MATERIAL_CHANGE_LABELS) as Array<keyof EvaluatedReleaseMaterialSignature>) {
    const value = signature?.[key];
    if (typeof value === "string" && value.trim().length > 0) {
      cleaned[key] = value.trim();
    }
  }
  return cleaned;
}

function signatureJson(
  signature: EvaluatedReleaseMaterialSignature,
): Record<string, string> {
  const json: Record<string, string> = {};
  for (const [key, value] of Object.entries(signature)) {
    if (typeof value === "string") {
      json[key] = value;
    }
  }
  return json;
}

function materialChangeReasons(
  previous: EvaluatedReleaseMaterialSignature,
  next: EvaluatedReleaseMaterialSignature,
): string[] {
  const reasons: string[] = [];
  for (const key of Object.keys(MATERIAL_CHANGE_LABELS) as Array<keyof EvaluatedReleaseMaterialSignature>) {
    const previousValue = previous[key] ?? null;
    const nextValue = next[key] ?? null;
    if (nextValue && nextValue !== previousValue) {
      reasons.push(MATERIAL_CHANGE_LABELS[key]);
    }
  }
  return reasons;
}

function mergeUniqueIds(previous: string[], next: string[] | undefined): string[] {
  return [...new Set([...(previous ?? []), ...(next ?? [])])];
}

function rowToRecord(row: EvaluatedReleaseRow): EvaluatedReleaseRecord {
  return {
    id: row.id,
    hiveId: row.hive_id,
    findingKey: row.finding_key,
    sourceUrl: row.source_url,
    sourceDate: isoDate(row.source_date),
    firstSeenCycleDate: isoDate(row.first_seen_cycle_date),
    lastSeenCycleDate: isoDate(row.last_seen_cycle_date),
    disposition: row.disposition,
    confidence: Number(row.confidence),
    terminalRationale: row.terminal_rationale,
    nextTrigger: row.next_trigger,
    linkedTaskIds: row.linked_task_ids ?? [],
    linkedDecisionIds: row.linked_decision_ids ?? [],
    materialSignature: row.material_signature ?? {},
    lastMaterialChangeReason: row.last_material_change_reason,
  };
}

function validateInput(input: EvaluatedReleaseRegistryInput, normalizedFindingKey: string): void {
  if (!normalizedFindingKey) {
    throw new Error("findingKey must contain at least one alphanumeric character");
  }
  if (input.confidence < 0 || input.confidence > 1) {
    throw new Error("confidence must be between 0 and 1");
  }
  if (!input.terminalRationale && !input.nextTrigger) {
    throw new Error("terminalRationale or nextTrigger is required");
  }
}

export async function recordEvaluatedReleaseFinding(
  sql: Sql,
  input: EvaluatedReleaseRegistryInput,
): Promise<EvaluatedReleaseRegistryResult> {
  const findingKey = normalizeFindingKey(input.findingKey);
  validateInput(input, findingKey);

  const materialSignature = cleanSignature(input.materialSignature);
  const [existing] = await sql<EvaluatedReleaseRow[]>`
    SELECT *
    FROM current_tech_evaluated_releases
    WHERE hive_id = ${input.hiveId}::uuid
      AND finding_key = ${findingKey}
    LIMIT 1
  `;

  if (!existing) {
    const [created] = await sql<EvaluatedReleaseRow[]>`
      INSERT INTO current_tech_evaluated_releases (
        hive_id,
        finding_key,
        source_url,
        source_date,
        first_seen_cycle_date,
        last_seen_cycle_date,
        disposition,
        confidence,
        terminal_rationale,
        next_trigger,
        linked_task_ids,
        linked_decision_ids,
        material_signature
      )
      VALUES (
        ${input.hiveId}::uuid,
        ${findingKey},
        ${input.sourceUrl},
        ${input.sourceDate}::date,
        ${input.cycleDate}::date,
        ${input.cycleDate}::date,
        ${input.disposition},
        ${input.confidence},
        ${input.terminalRationale ?? null},
        ${input.nextTrigger ?? null},
        ${input.linkedTaskIds ?? []}::uuid[],
        ${input.linkedDecisionIds ?? []}::uuid[],
        ${sql.json(signatureJson(materialSignature))}::jsonb
      )
      RETURNING *
    `;

    return {
      record: rowToRecord(created),
      action: "created",
      suppressDuplicateWork: false,
      materialChangeReasons: [],
    };
  }

  const priorRecord = rowToRecord(existing);
  const repeatAgeDays = daysBetween(priorRecord.lastSeenCycleDate, input.cycleDate);
  const recentRepeat = repeatAgeDays >= 0 && repeatAgeDays <= RECENT_REPEAT_WINDOW_DAYS;
  const reasons = materialChangeReasons(priorRecord.materialSignature, materialSignature);
  const shouldReuse = recentRepeat && reasons.length === 0;
  const linkedTaskIds = mergeUniqueIds(priorRecord.linkedTaskIds, input.linkedTaskIds);
  const linkedDecisionIds = mergeUniqueIds(priorRecord.linkedDecisionIds, input.linkedDecisionIds);

  const [updated] = await sql<EvaluatedReleaseRow[]>`
    UPDATE current_tech_evaluated_releases
    SET
      source_url = ${input.sourceUrl},
      source_date = ${input.sourceDate}::date,
      last_seen_cycle_date = ${input.cycleDate}::date,
      disposition = ${shouldReuse ? priorRecord.disposition : input.disposition},
      confidence = ${shouldReuse ? priorRecord.confidence : input.confidence},
      terminal_rationale = ${shouldReuse ? priorRecord.terminalRationale : input.terminalRationale ?? null},
      next_trigger = ${shouldReuse ? priorRecord.nextTrigger : input.nextTrigger ?? null},
      linked_task_ids = ${linkedTaskIds}::uuid[],
      linked_decision_ids = ${linkedDecisionIds}::uuid[],
      material_signature = ${sql.json(signatureJson(shouldReuse ? priorRecord.materialSignature : materialSignature))}::jsonb,
      last_material_change_reason = ${reasons[0] ?? priorRecord.lastMaterialChangeReason},
      updated_at = now()
    WHERE id = ${priorRecord.id}::uuid
    RETURNING *
  `;

  return {
    record: rowToRecord(updated),
    action: shouldReuse ? "reused" : "material_change",
    suppressDuplicateWork: shouldReuse,
    materialChangeReasons: reasons,
  };
}
