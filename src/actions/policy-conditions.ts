import type { ConnectorRiskTier } from "@/connectors/registry";

export interface ActionPolicyConditions {
  maxAmount?: number;
  amountField?: string;
  allowedDomains?: string[];
  destinationField?: string;
  allowedDestinations?: string[];
  businessHoursOnly?: boolean;
  requireDryRun?: boolean;
  riskTierAtMost?: ConnectorRiskTier;
}

export interface ConditionMatchInput {
  conditions?: ActionPolicyConditions | Record<string, unknown> | null;
  args?: unknown;
  now?: Date;
  riskTier?: ConnectorRiskTier | string | null;
}

const RISK_TIER_RANK: Record<ConnectorRiskTier, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function conditionsMatchAction(input: ConditionMatchInput): boolean {
  const conditions = normalizeActionPolicyConditions(input.conditions ?? {});
  if (!conditions) return false;

  const args = isRecord(input.args) ? input.args : {};

  if (conditions.maxAmount !== undefined) {
    const amount = valueAtPath(args, conditions.amountField ?? "amount");
    const numericAmount = typeof amount === "number" ? amount : Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount > conditions.maxAmount) {
      return false;
    }
  }

  const destinationField = conditions.destinationField ?? "destination";
  if (conditions.allowedDestinations && conditions.allowedDestinations.length > 0) {
    const values = flattenValues(valueAtPath(args, destinationField));
    if (values.length === 0 || !values.every((value) => conditions.allowedDestinations?.includes(value))) {
      return false;
    }
  }

  if (conditions.allowedDomains && conditions.allowedDomains.length > 0) {
    const values = flattenValues(valueAtPath(args, conditions.destinationField ?? "to"));
    const allowedDomains = conditions.allowedDomains.map((domain) => domain.toLowerCase());
    if (values.length === 0 || !values.every((value) => {
      const domain = domainFromDestination(value);
      return domain ? allowedDomains.includes(domain) : false;
    })) {
      return false;
    }
  }

  if (conditions.businessHoursOnly) {
    const now = input.now ?? new Date();
    const day = now.getDay();
    const hour = now.getHours();
    if (day === 0 || day === 6 || hour < 9 || hour >= 17) {
      return false;
    }
  }

  if (conditions.requireDryRun) {
    if (valueAtPath(args, "dryRun") !== true && valueAtPath(args, "dry_run") !== true) {
      return false;
    }
  }

  if (conditions.riskTierAtMost) {
    const riskTier = normalizeRiskTier(input.riskTier);
    if (!riskTier || RISK_TIER_RANK[riskTier] > RISK_TIER_RANK[conditions.riskTierAtMost]) {
      return false;
    }
  }

  return true;
}

export function normalizeActionPolicyConditions(
  value: unknown,
): ActionPolicyConditions | null {
  if (!isRecord(value)) return null;
  const conditions: ActionPolicyConditions = {};

  if (value.maxAmount !== undefined) {
    if (typeof value.maxAmount !== "number" || !Number.isFinite(value.maxAmount)) return null;
    conditions.maxAmount = value.maxAmount;
  }
  if (value.amountField !== undefined) {
    if (typeof value.amountField !== "string") return null;
    conditions.amountField = value.amountField.trim();
  }
  if (value.destinationField !== undefined) {
    if (typeof value.destinationField !== "string") return null;
    conditions.destinationField = value.destinationField.trim();
  }
  if (value.allowedDomains !== undefined) {
    if (!isStringArray(value.allowedDomains)) return null;
    conditions.allowedDomains = value.allowedDomains.map((item) => item.trim().toLowerCase()).filter(Boolean);
  }
  if (value.allowedDestinations !== undefined) {
    if (!isStringArray(value.allowedDestinations)) return null;
    conditions.allowedDestinations = value.allowedDestinations.map((item) => item.trim()).filter(Boolean);
  }
  if (value.businessHoursOnly !== undefined) {
    if (typeof value.businessHoursOnly !== "boolean") return null;
    conditions.businessHoursOnly = value.businessHoursOnly;
  }
  if (value.requireDryRun !== undefined) {
    if (typeof value.requireDryRun !== "boolean") return null;
    conditions.requireDryRun = value.requireDryRun;
  }
  if (value.riskTierAtMost !== undefined) {
    const riskTier = normalizeRiskTier(value.riskTierAtMost);
    if (!riskTier) return null;
    conditions.riskTierAtMost = riskTier;
  }

  const known = new Set([
    "maxAmount",
    "amountField",
    "allowedDomains",
    "destinationField",
    "allowedDestinations",
    "businessHoursOnly",
    "requireDryRun",
    "riskTierAtMost",
  ]);
  if (Object.keys(value).some((key) => !known.has(key))) return null;

  return Object.fromEntries(
    Object.entries(conditions).filter(([, item]) => {
      if (Array.isArray(item)) return item.length > 0;
      return item !== "" && item !== undefined;
    }),
  ) as ActionPolicyConditions;
}

function valueAtPath(value: Record<string, unknown>, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((current, part) => {
    if (!isRecord(current)) return undefined;
    return current[part];
  }, value);
}

function flattenValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(flattenValues);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function domainFromDestination(value: string): string | null {
  const emailMatch = value.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  if (emailMatch) return emailMatch[1].toLowerCase();
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeRiskTier(value: unknown): ConnectorRiskTier | null {
  return typeof value === "string" && value in RISK_TIER_RANK
    ? value as ConnectorRiskTier
    : null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
