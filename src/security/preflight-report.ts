import { existsSync, readFileSync } from "node:fs";
import { resolveRuntimePath } from "@/runtime/paths";

export type SecurityPreflightStatus = "pass" | "fail" | "unsupported";

export interface SecurityPreflightFinding {
  severity: string;
  title: string;
  detail: string;
  file?: string;
  line?: number;
}

export interface SecurityPreflightCheck {
  status: SecurityPreflightStatus;
  summary: string;
  findings: SecurityPreflightFinding[];
}

export interface TaskSecurityPreflight {
  reportPath: string | null;
  generatedAt: string | null;
  secretScan: SecurityPreflightCheck;
  dependencyScan: SecurityPreflightCheck;
}

type RawCheckStatus = "pass" | "warn" | "fail" | "error";

type RawCheck = {
  name?: unknown;
  status?: unknown;
  findings?: unknown;
};

type RawReport = {
  summary?: {
    generatedAt?: unknown;
  } | null;
  checks?: unknown;
};

const REPORT_SEGMENTS = ["reports", "security", "baseline-security-scan.json"];

function unsupportedCheck(summary: string): SecurityPreflightCheck {
  return {
    status: "unsupported",
    summary,
    findings: [],
  };
}

function normalizeFinding(value: unknown): SecurityPreflightFinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const title = typeof source.title === "string" ? source.title : "";
  const detail = typeof source.detail === "string" ? source.detail : "";
  if (!title && !detail) return null;

  return {
    severity: typeof source.severity === "string" ? source.severity : "unknown",
    title,
    detail,
    file: typeof source.file === "string" ? source.file : undefined,
    line: typeof source.line === "number" ? source.line : undefined,
  };
}

function normalizeCheck(value: unknown): RawCheck | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as RawCheck;
}

function toPreflightStatus(status: RawCheckStatus): SecurityPreflightStatus {
  switch (status) {
    case "pass":
      return "pass";
    case "warn":
    case "fail":
      return "fail";
    case "error":
    default:
      return "unsupported";
  }
}

function summarizeCheck(name: string, status: RawCheckStatus, findings: SecurityPreflightFinding[]): string {
  if (findings.length === 0) {
    return `${name} reported ${status}.`;
  }

  const [first] = findings;
  if (!first) return `${name} reported ${status}.`;
  return first.detail || first.title || `${name} reported ${status}.`;
}

function normalizePreflightCheck(checkName: string, report: RawReport): SecurityPreflightCheck {
  if (!Array.isArray(report.checks)) {
    return unsupportedCheck("Security scan report did not include any checks.");
  }

  const rawCheck = report.checks
    .map(normalizeCheck)
    .find((check) => check && check.name === checkName);

  if (!rawCheck) {
    return unsupportedCheck(`Security scan report did not include the ${checkName} check.`);
  }

  const status = typeof rawCheck.status === "string" ? rawCheck.status as RawCheckStatus : "error";
  const findings = Array.isArray(rawCheck.findings)
    ? rawCheck.findings.flatMap((finding) => {
        const normalized = normalizeFinding(finding);
        return normalized ? [normalized] : [];
      })
    : [];

  return {
    status: toPreflightStatus(status),
    summary: summarizeCheck(checkName, status, findings),
    findings,
  };
}

export function resolveSecurityPreflightReportPath(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot = process.cwd(),
): string {
  return resolveRuntimePath(REPORT_SEGMENTS, env, repoRoot);
}

export function readTaskSecurityPreflight(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot = process.cwd(),
): TaskSecurityPreflight {
  const reportPath = resolveSecurityPreflightReportPath(env, repoRoot);
  if (!existsSync(reportPath)) {
    return {
      reportPath,
      generatedAt: null,
      secretScan: unsupportedCheck(`Security scan report not found at ${reportPath}. Run npm run security:scan.`),
      dependencyScan: unsupportedCheck(`Security scan report not found at ${reportPath}. Run npm run security:scan.`),
    };
  }

  let parsed: RawReport;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8")) as RawReport;
  } catch {
    return {
      reportPath,
      generatedAt: null,
      secretScan: unsupportedCheck("Security scan report is unreadable or invalid JSON."),
      dependencyScan: unsupportedCheck("Security scan report is unreadable or invalid JSON."),
    };
  }

  return {
    reportPath,
    generatedAt: typeof parsed.summary?.generatedAt === "string" ? parsed.summary.generatedAt : null,
    secretScan: normalizePreflightCheck("secret-detection", parsed),
    dependencyScan: normalizePreflightCheck("dependency-audit", parsed),
  };
}
