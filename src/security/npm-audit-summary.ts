type AuditCounts = {
  critical: number;
  high: number;
  moderate: number;
  low: number;
};

export type NpmAuditSummary = {
  counts: AuditCounts;
  countDetail: string;
  blockingDetail: string | null;
  blockingFindingDetails: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function severityBlocks(value: unknown): boolean {
  return value === "critical" || value === "high";
}

function extractAdvisoryId(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = url.match(/GHSA-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/i);
  return match ? match[0] : null;
}

function summarizeViaEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (!isRecord(entry) || !severityBlocks(entry.severity)) return null;

  const title = typeof entry.title === "string" && entry.title.trim()
    ? entry.title.trim()
    : typeof entry.name === "string" && entry.name.trim()
      ? entry.name.trim()
      : "untitled advisory";
  const advisoryId = extractAdvisoryId(entry.url);

  return advisoryId ? `${title} (${advisoryId})` : title;
}

function summarizeVulnerability(name: string, value: unknown): string | null {
  if (!isRecord(value) || !severityBlocks(value.severity)) return null;

  const via = Array.isArray(value.via)
    ? value.via.flatMap((entry) => {
        const summary = summarizeViaEntry(entry);
        return summary ? [summary] : [];
      })
    : [];

  const packageName = typeof value.name === "string" && value.name.trim()
    ? value.name.trim()
    : name;
  const detail = via.length > 0
    ? via.join("; ")
    : `${String(value.severity)} severity vulnerability`;

  return `${packageName}: ${detail}`;
}

export function summarizeNpmAuditReport(report: unknown): NpmAuditSummary {
  const parsed = asRecord(report);
  const vulnerabilityCounts = asRecord(asRecord(parsed.metadata).vulnerabilities);
  const counts = {
    critical: numberValue(vulnerabilityCounts.critical),
    high: numberValue(vulnerabilityCounts.high),
    moderate: numberValue(vulnerabilityCounts.moderate),
    low: numberValue(vulnerabilityCounts.low),
  };
  const countDetail =
    `npm audit summary: ${counts.critical} critical, ${counts.high} high, ` +
    `${counts.moderate} moderate, ${counts.low} low.`;

  const vulnerabilities = asRecord(parsed.vulnerabilities);
  const blockingFindingDetails = Object.entries(vulnerabilities).flatMap(([name, value]) => {
    const summary = summarizeVulnerability(name, value);
    return summary ? [summary] : [];
  });

  return {
    counts,
    countDetail,
    blockingDetail: blockingFindingDetails.length > 0
      ? `Blocking npm audit advisories: ${blockingFindingDetails.join(" | ")}.`
      : null,
    blockingFindingDetails,
  };
}
