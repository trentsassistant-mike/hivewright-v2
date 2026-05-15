import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type GeneratedPathPreflightStatus = "pass" | "fail" | "not_enabled";

export interface GeneratedPathPreflightFinding {
  category: "secret-material" | "claim-boundary" | "provenance" | "path-resolution";
  severity: "high";
  title: string;
  detail: string;
  file?: string;
  line?: number;
}

export interface GeneratedPathPreflightResult {
  status: GeneratedPathPreflightStatus;
  summary: string;
  findings: GeneratedPathPreflightFinding[];
  scannedFiles: string[];
}

interface ScanGeneratedPathPreflightOptions {
  repoRoot: string;
  candidatePaths: string[];
}

const TEXT_FILE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const OPERATIONAL_ARTIFACT_EXTENSIONS = new Set([".json", ".md", ".txt", ".yaml", ".yml"]);
const OPERATIONAL_ARTIFACT_PATH_HINT = /(artifact|brief|closeout|completion|handoff|owner|report|result|summary)/i;
const OPERATIONAL_ARTIFACT_CONTENT_HINT = /\b(?:owner handoff|summary|deliverable|result|verification)\b/i;

const PROVENANCE_MARKER_PATTERNS = [
  /^##\s+(?:Evidence|Verification|Provenance|Sources)\b/im,
  /"\s*(?:evidence|evidenceTaskIds|evidenceWorkProductIds|provenanceUrl|reportPath)\s*"\s*:/i,
  /\btask_context_provenance\b/i,
];

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/gi,
  /\b(?:sk|ghp)_[A-Za-z0-9_-]{16,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}\b/gi,
  /\b(?:api[_-]?key|apiKey|token|secret|password|client[_-]?secret|authorization)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{16,}/gi,
  /"(?:api[_-]?key|apiKey|token|secret|password|client[_-]?secret|authorization)"\s*:\s*"[A-Za-z0-9._~+/-]{16,}"/gi,
];

const CLAIM_PATTERNS = [
  { title: "Generated text makes an unbounded autonomy claim", pattern: /\bfully autonomous\b/i },
  { title: "Generated text makes a guaranteed-completion claim", pattern: /\bguaranteed complete\b/i },
  { title: "Generated text removes owner or human review", pattern: /\bwithout (?:owner|human) review\b/i },
  { title: "Generated text removes approval gates", pattern: /\bno human approval required\b/i },
];

const CLAIM_NEGATION_PATTERN = /\b(?:do not|don't|must not|never|avoid|not)\b/i;
const PLACEHOLDER_SECRET_PATTERN = /\b(?:example|placeholder|replace-with|dummy|test|fake|redacted)\b/i;

function isPathInsideRepo(repoRoot: string, absolutePath: string): boolean {
  const relative = path.relative(repoRoot, absolutePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSupportedTextFile(filePath: string): boolean {
  return TEXT_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function collectFiles(
  repoRoot: string,
  candidatePath: string,
  findings: GeneratedPathPreflightFinding[],
): string[] {
  const absoluteCandidate = path.resolve(repoRoot, candidatePath);
  if (!isPathInsideRepo(repoRoot, absoluteCandidate)) {
    findings.push({
      category: "path-resolution",
      severity: "high",
      title: "Generated-path preflight target escapes the repository root",
      detail: "Generated-path targets must stay inside the verified repository root.",
      file: candidatePath,
    });
    return [];
  }

  if (!existsSync(absoluteCandidate)) {
    findings.push({
      category: "path-resolution",
      severity: "high",
      title: "Generated-path preflight target does not exist",
      detail: "Provided generated-path target could not be resolved. The preflight must not silently skip missing files.",
      file: candidatePath,
    });
    return [];
  }

  const stats = statSync(absoluteCandidate);
  if (stats.isDirectory()) {
    return readdirSync(absoluteCandidate, { withFileTypes: true }).flatMap((entry) => collectFiles(
      repoRoot,
      path.relative(repoRoot, path.join(absoluteCandidate, entry.name)),
      findings,
    ));
  }

  return isSupportedTextFile(absoluteCandidate) ? [absoluteCandidate] : [];
}

function lineNumberForIndex(content: string, matchIndex: number): number {
  return content.slice(0, matchIndex).split("\n").length;
}

function hasProvenanceMarkers(content: string): boolean {
  return PROVENANCE_MARKER_PATTERNS.some((pattern) => pattern.test(content));
}

function looksLikeOperationalArtifact(relativePath: string, content: string): boolean {
  const extension = path.extname(relativePath).toLowerCase();
  if (!OPERATIONAL_ARTIFACT_EXTENSIONS.has(extension)) return false;
  return OPERATIONAL_ARTIFACT_PATH_HINT.test(relativePath) || OPERATIONAL_ARTIFACT_CONTENT_HINT.test(content);
}

function isPlaceholderSecret(matchText: string): boolean {
  return PLACEHOLDER_SECRET_PATTERN.test(matchText);
}

function findSecretFindings(relativePath: string, content: string): GeneratedPathPreflightFinding[] {
  const findings: GeneratedPathPreflightFinding[] = [];

  for (const pattern of SECRET_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const matchedText = match[0] ?? "";
      if (!matchedText || isPlaceholderSecret(matchedText)) continue;
      findings.push({
        category: "secret-material",
        severity: "high",
        title: "Generated path contains obvious secret or credential-like material",
        detail: "Credential-like material was detected in a generated path. Secret values are redacted from scanner output; move them to runtime secret storage.",
        file: relativePath,
        line: typeof match.index === "number" ? lineNumberForIndex(content, match.index) : undefined,
      });
      return findings;
    }
  }

  return findings;
}

function findClaimFindings(relativePath: string, content: string): GeneratedPathPreflightFinding[] {
  const findings: GeneratedPathPreflightFinding[] = [];
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    if (CLAIM_NEGATION_PATTERN.test(line)) continue;

    for (const claim of CLAIM_PATTERNS) {
      if (claim.pattern.test(line)) {
        findings.push({
          category: "claim-boundary",
          severity: "high",
          title: claim.title,
          detail: "Owner/customer-facing generated text must use bounded language such as owner-approved workflows, governed automation, or explicit approval gates.",
          file: relativePath,
          line: index + 1,
        });
        return findings;
      }
    }
  }

  return findings;
}

function findProvenanceFindings(relativePath: string, content: string): GeneratedPathPreflightFinding[] {
  if (!looksLikeOperationalArtifact(relativePath, content) || hasProvenanceMarkers(content)) {
    return [];
  }

  return [{
    category: "provenance",
    severity: "high",
    title: "Generated operational artifact is missing evidence or provenance markers",
    detail:
      "Operational artifacts should carry evidence/provenance markers already used in this repo, such as Evidence/Verification/Provenance sections, evidenceTaskIds, evidenceWorkProductIds, provenanceUrl, reportPath, or task_context_provenance.",
    file: relativePath,
  }];
}

export function scanGeneratedPathPreflight({
  repoRoot,
  candidatePaths,
}: ScanGeneratedPathPreflightOptions): GeneratedPathPreflightResult {
  if (candidatePaths.length === 0) {
    return {
      status: "not_enabled",
      summary: "Generated-path preflight not enabled; provide one or more --generated-path arguments.",
      findings: [],
      scannedFiles: [],
    };
  }

  const findings: GeneratedPathPreflightFinding[] = [];
  const scannedFiles = Array.from(new Set(candidatePaths.flatMap((candidatePath) => collectFiles(repoRoot, candidatePath, findings))))
    .sort()
    .map((absolutePath) => path.relative(repoRoot, absolutePath));

  for (const relativePath of scannedFiles) {
    const absolutePath = path.join(repoRoot, relativePath);
    const content = readFileSync(absolutePath, "utf8");
    findings.push(...findSecretFindings(relativePath, content));
    findings.push(...findClaimFindings(relativePath, content));
    findings.push(...findProvenanceFindings(relativePath, content));
  }

  if (findings.length > 0) {
    return {
      status: "fail",
      summary: `Generated-path preflight found ${findings.length} blocking finding${findings.length === 1 ? "" : "s"} across ${scannedFiles.length} file${scannedFiles.length === 1 ? "" : "s"}.`,
      findings,
      scannedFiles,
    };
  }

  return {
    status: "pass",
    summary: `Generated-path preflight scanned ${scannedFiles.length} file without blocking findings.`,
    findings: [],
    scannedFiles,
  };
}
