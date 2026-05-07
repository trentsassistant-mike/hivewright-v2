import { spawnSync } from "child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";

type Severity = "pass" | "warn" | "high" | "critical";
type CheckStatus = "pass" | "warn" | "fail" | "error";

type Finding = {
  check: string;
  severity: Severity;
  title: string;
  detail: string;
  file?: string;
  line?: number;
};

type CommandResult = {
  command: string;
  status: number | null;
  signal: NodeJS.Signals | null;
};

type CheckResult = {
  name: string;
  status: CheckStatus;
  findings: Finding[];
};

const repoRoot = process.cwd();
const reportDir = path.resolve(
  repoRoot,
  process.env.SECURITY_SCAN_REPORT_DIR ?? ".security-reports",
);
const jsonReportPath = path.join(reportDir, "baseline-security-scan.json");
const markdownReportPath = path.join(reportDir, "baseline-security-scan.md");
const gitleaksReportPath = path.join(reportDir, "gitleaks.json");

const findings: Finding[] = [];
const checks: CheckResult[] = [];
const commandResults: CommandResult[] = [];
let setupError = false;

const publicApiPrefixes = [
  "src/app/api/auth/",
  "src/app/api/oauth/callback/",
  "src/app/api/voice/twiml/",
  "src/app/api/voice/ws/",
];

const authInvariantTokens = [
  "requireApiAuth",
  "requireApiUser",
  "requireSystemOwner",
];

function addFinding(finding: Finding) {
  findings.push(finding);
}

function addCheck(name: string, status: CheckStatus, checkFindings: Finding[]) {
  checks.push({ name, status, findings: checkFindings });
  checkFindings.forEach(addFinding);
}

function runCommand(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  const printable = [command, ...args].join(" ");
  const result = spawnSync(command, args, {
    cwd: options?.cwd ?? repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...options?.env },
    maxBuffer: 1024 * 1024 * 20,
  });
  const commandResult: CommandResult = {
    command: printable,
    status: result.status,
    signal: result.signal,
  };
  commandResults.push(commandResult);
  return {
    ...commandResult,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function commandExists(command: string) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.status === 0;
}

function listGitFiles(patterns: string[] = []) {
  const args = ["ls-files", "-z", ...patterns];
  const result = runCommand("git", args);
  if (result.status !== 0) {
    setupError = true;
    return [];
  }
  return result.stdout.split("\0").filter(Boolean);
}

function ensureRepoRoot() {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"]);
  if (result.status !== 0 || path.resolve(result.stdout.trim()) !== repoRoot) {
    setupError = true;
    addCheck("setup", "error", [
      {
        check: "setup",
        severity: "critical",
        title: "Scanner must run from the git repository root",
        detail: "Run npm run security:scan from the current clone root.",
      },
    ]);
    return false;
  }
  return true;
}

function runDependencyAudit() {
  const checkFindings: Finding[] = [];
  if (!existsSync(path.join(repoRoot, "package-lock.json"))) {
    setupError = true;
    checkFindings.push({
      check: "dependency-audit",
      severity: "critical",
      title: "package-lock.json is missing",
      detail: "npm audit requires the package-lock.json dependency record.",
    });
    addCheck("dependency-audit", "error", checkFindings);
    return;
  }

  const audit = runCommand("npm", ["audit", "--audit-level=high", "--json"]);
  const parsed = parseJson(audit.stdout);
  if (!parsed || !isRecord(parsed)) {
    setupError = true;
    checkFindings.push({
      check: "dependency-audit",
      severity: "critical",
      title: "npm audit did not return parseable JSON",
      detail: `Command exited ${audit.status ?? "without a status"}.`,
    });
    addCheck("dependency-audit", "error", checkFindings);
    return;
  }

  const metadata = asRecord(parsed.metadata);
  const vulnerabilityCounts = asRecord(metadata.vulnerabilities);
  const high = Number(vulnerabilityCounts.high ?? 0);
  const critical = Number(vulnerabilityCounts.critical ?? 0);
  const moderate = Number(vulnerabilityCounts.moderate ?? 0);
  const low = Number(vulnerabilityCounts.low ?? 0);

  if (critical > 0 || high > 0) {
    checkFindings.push({
      check: "dependency-audit",
      severity: critical > 0 ? "critical" : "high",
      title: "npm audit found high or critical vulnerabilities",
      detail: `npm audit summary: ${critical} critical, ${high} high, ${moderate} moderate, ${low} low.`,
    });
  } else {
    checkFindings.push({
      check: "dependency-audit",
      severity: "pass",
      title: "No high or critical npm audit findings",
      detail: `npm audit completed with ${moderate} moderate and ${low} low findings below the v1 blocking threshold.`,
    });
  }

  addCheck("dependency-audit", critical > 0 || high > 0 ? "fail" : "pass", checkFindings);
}

function copyTrackedFiles(targetDir: string) {
  const files = listGitFiles();
  for (const file of files) {
    const source = path.join(repoRoot, file);
    const destination = path.join(targetDir, file);
    const stats = statSync(source);
    if (!stats.isFile()) continue;
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  return files.length;
}

function runGitleaks() {
  const checkFindings: Finding[] = [];
  if (!commandExists("gitleaks")) {
    setupError = true;
    checkFindings.push({
      check: "secret-detection",
      severity: "critical",
      title: "gitleaks is not installed",
      detail: "Install gitleaks to run the v1 tracked-file secret scan.",
    });
    addCheck("secret-detection", "error", checkFindings);
    return;
  }

  mkdirSync(reportDir, { recursive: true });
  const trackedCopy = mkdtempSync(path.join(tmpdir(), "hivewright-security-scan-"));
  try {
    const copiedFiles = copyTrackedFiles(trackedCopy);
    if (copiedFiles === 0 || setupError) {
      setupError = true;
      checkFindings.push({
        check: "secret-detection",
        severity: "critical",
        title: "Could not prepare tracked-file copy",
        detail: "git ls-files returned no usable files or failed.",
      });
      addCheck("secret-detection", "error", checkFindings);
      return;
    }

    const result = runCommand("gitleaks", [
      "detect",
      "--no-git",
      "--source",
      trackedCopy,
      "--redact=100",
      "--report-format",
      "json",
      "--report-path",
      gitleaksReportPath,
      "--no-banner",
    ]);

    if (result.status === 0) {
      checkFindings.push({
        check: "secret-detection",
        severity: "pass",
        title: "No gitleaks findings in tracked files",
        detail: `gitleaks scanned ${copiedFiles} tracked files from a temporary copy.`,
      });
      addCheck("secret-detection", "pass", checkFindings);
      return;
    }

    const report = existsSync(gitleaksReportPath)
      ? parseJson(readFileSync(gitleaksReportPath, "utf8"))
      : null;
    if (!Array.isArray(report)) {
      setupError = true;
      checkFindings.push({
        check: "secret-detection",
        severity: "critical",
        title: "gitleaks failed without a parseable JSON report",
        detail: `gitleaks exited ${result.status ?? "without a status"}.`,
      });
      addCheck("secret-detection", "error", checkFindings);
      return;
    }

    for (const rawFinding of report) {
      const leak = asRecord(rawFinding);
      const sourceFile = String(leak.File ?? "unknown");
      const normalizedFile = sourceFile.startsWith(trackedCopy)
        ? path.relative(trackedCopy, sourceFile)
        : sourceFile;
      checkFindings.push({
        check: "secret-detection",
        severity: "high",
        title: `gitleaks finding: ${String(leak.RuleID ?? "unknown-rule")}`,
        detail: "A tracked-file secret finding was reported. Secret value is redacted; inspect locally and rotate if real.",
        file: normalizedFile,
        line: typeof leak.StartLine === "number" ? leak.StartLine : undefined,
      });
    }
    addCheck("secret-detection", "fail", checkFindings);
  } finally {
    rmSync(trackedCopy, { recursive: true, force: true });
  }
}

function runPermissionChecks() {
  const checkFindings: Finding[] = [];
  const sensitiveFiles = [".env", ".env.local", ".env.production", ".npmrc"];
  for (const file of sensitiveFiles) {
    const absolutePath = path.join(repoRoot, file);
    if (!existsSync(absolutePath)) continue;
    const mode = statSync(absolutePath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      checkFindings.push({
        check: "file-permissions",
        severity: "high",
        title: `${file} is readable by group or others`,
        detail: `${file} mode is ${mode.toString(8)}. Use chmod 600 ${file}.`,
        file,
      });
    } else {
      checkFindings.push({
        check: "file-permissions",
        severity: "pass",
        title: `${file} permissions are restricted`,
        detail: `${file} mode is ${mode.toString(8)}.`,
        file,
      });
    }
  }

  if (checkFindings.length === 0) {
    checkFindings.push({
      check: "file-permissions",
      severity: "pass",
      title: "No local sensitive files found for permission checks",
      detail: "Checked .env, .env.local, .env.production, and .npmrc without reading their contents.",
    });
  }
  addCheck(
    "file-permissions",
    checkFindings.some((finding) => finding.severity === "high") ? "fail" : "pass",
    checkFindings,
  );
}

function isPublicApiRoute(file: string) {
  return publicApiPrefixes.some((prefix) => file.startsWith(prefix));
}

function runApiAuthInvariantChecks() {
  const checkFindings: Finding[] = [];
  const routeFiles = listGitFiles(["src/app/api/**/route.ts"]);
  if (routeFiles.length === 0 || setupError) {
    setupError = true;
    checkFindings.push({
      check: "api-auth-invariants",
      severity: "critical",
      title: "Could not enumerate API route handlers",
      detail: "git ls-files did not return src/app/api/**/route.ts files.",
    });
    addCheck("api-auth-invariants", "error", checkFindings);
    return;
  }

  const missingAuth = routeFiles
    .filter((file) => !isPublicApiRoute(file))
    .filter((file) => {
      const content = readFileSync(path.join(repoRoot, file), "utf8");
      return !authInvariantTokens.some((token) => content.includes(token));
    });

  if (missingAuth.length === 0) {
    checkFindings.push({
      check: "api-auth-invariants",
      severity: "pass",
      title: "All non-public API routes document a local auth invariant",
      detail: `Checked ${routeFiles.length} tracked route handlers; public prefixes are ${publicApiPrefixes.join(", ")}.`,
    });
    addCheck("api-auth-invariants", "pass", checkFindings);
    return;
  }

  for (const file of missingAuth) {
    checkFindings.push({
      check: "api-auth-invariants",
      severity: "high",
      title: "Non-public API route lacks a local auth invariant token",
      detail: `Expected one of ${authInvariantTokens.join(", ")}. The framework proxy may still gate the route, but missing local evidence is a blocking scanner finding until reviewed or documented as public.`,
      file,
    });
  }
  addCheck("api-auth-invariants", "fail", checkFindings);
}

function summarize() {
  const counts = findings.reduce<Record<Severity, number>>(
    (acc, finding) => {
      acc[finding.severity] += 1;
      return acc;
    },
    { pass: 0, warn: 0, high: 0, critical: 0 },
  );

  let exitCode = 0;
  if (counts.high > 0 || counts.critical > 0) exitCode = 1;
  if (setupError) exitCode = 2;

  return {
    generatedAt: new Date().toISOString(),
    repoRoot,
    reportDir,
    publicApiPrefixes,
    authInvariantTokens,
    threshold: "Exit 0 on pass, 1 on blocking findings, 2 on scanner/setup error.",
    status: exitCode === 0 ? "pass" : exitCode === 1 ? "fail" : "error",
    counts,
    exitCode,
  };
}

function writeReports() {
  mkdirSync(reportDir, { recursive: true });
  const summary = summarize();
  const report = {
    summary,
    checks,
    findings,
    commands: commandResults,
  };

  writeFileSync(jsonReportPath, `${JSON.stringify(report, null, 2)}\n`);

  const markdown = [
    "# Baseline Security Scan",
    "",
    `Generated: ${summary.generatedAt}`,
    `Repo: ${summary.repoRoot}`,
    `Status: ${summary.status.toUpperCase()}`,
    `Exit code: ${summary.exitCode}`,
    "",
    "## Counts",
    "",
    `- Pass: ${summary.counts.pass}`,
    `- Warn: ${summary.counts.warn}`,
    `- High: ${summary.counts.high}`,
    `- Critical: ${summary.counts.critical}`,
    "",
    "## Findings",
    "",
    ...findings.map((finding) => {
      const location = finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : "";
      return `- ${finding.severity.toUpperCase()} [${finding.check}] ${finding.title}${location}: ${finding.detail}`;
    }),
    "",
    "## Commands",
    "",
    ...commandResults.map((command) => `- \`${command.command}\` exited ${command.status ?? "without a status"}`),
    "",
  ].join("\n");
  writeFileSync(markdownReportPath, markdown);
  return summary;
}

if (ensureRepoRoot()) {
  runDependencyAudit();
  runGitleaks();
  runPermissionChecks();
  runApiAuthInvariantChecks();
}

const summary = writeReports();

console.log(`Security scan status: ${summary.status.toUpperCase()}`);
console.log(`Report: ${path.relative(repoRoot, jsonReportPath)}`);
console.log(`Markdown: ${path.relative(repoRoot, markdownReportPath)}`);
console.log(
  `Counts: pass=${summary.counts.pass} warn=${summary.counts.warn} high=${summary.counts.high} critical=${summary.counts.critical}`,
);

process.exitCode = summary.exitCode;
