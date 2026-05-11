import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

type Finding = {
  check: string;
  file?: string;
  line?: number;
  detail: string;
};

const repoRoot = process.cwd();
const findings: Finding[] = [];

const bannedTrackedPrefixes = [
  "artifacts/",
  "docs/audit/",
  "docs/architecture/",
  "docs/conventions/",
  "docs/design/",
  "docs/engineering/",
  "docs/handoffs/",
  "docs/ops/",
  "docs/qa/",
  "docs/research/",
  "docs/security/",
  "docs/superpowers/",
  "docs/ui/",
  "docs/work-products/",
  "planning/",
];

const bannedTrackedFiles = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
  "SOUL.md",
  "TOOLS.md",
  "USER.md",
]);

const allowedDocs = new Set([
  "docs/STREAMING.md",
  "docs/installation.md",
  "docs/public-repository-boundary.md",
  "docs/voice-ea/README.md",
]);

const privateHostMarkers = [
  "trents" + "box",
  "trents" + "clawdbot",
  "tail5f" + "6305",
  "cla" + "wd",
].join("|");

const bannedContent = [
  {
    label: "private home path",
    regex: /\/home\/trent\b/g,
  },
  {
    label: "private host/user marker",
    regex: new RegExp(`\\b(?:${privateHostMarkers})\\b`, "g"),
  },
  {
    label: "private postgres URL",
    regex: /postgres(?:ql)?:\/\/(?:trent\b|[^@\s]+:hivewright@localhost:5433\b)/g,
  },
  {
    label: "maintainer secrets include",
    regex: new RegExp("/home/" + "trent/" + "cla" + "wd/\\.secrets\\.env", "g"),
  },
];

function runGit(args: string[]) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function addFinding(finding: Finding) {
  findings.push(finding);
}

function listTrackedFiles() {
  const output = runGit(["ls-files", "-z"]);
  return output.split("\0").filter(Boolean);
}

function isBinary(buffer: Buffer) {
  return buffer.subarray(0, 4096).includes(0);
}

function lineForIndex(text: string, index: number) {
  return text.slice(0, index).split("\n").length;
}

function scanTrackedBoundary(files: string[]) {
  for (const file of files) {
    if (bannedTrackedFiles.has(file)) {
      addFinding({
        check: "tracked-local-file",
        file,
        detail: "Local agent/runtime identity file is tracked; keep it ignored and local-only.",
      });
    }

    const bannedPrefix = bannedTrackedPrefixes.find((prefix) => file.startsWith(prefix));
    if (bannedPrefix) {
      addFinding({
        check: "tracked-operational-path",
        file,
        detail: `Path is under operational/private-only prefix ${bannedPrefix}.`,
      });
    }

    if (file.startsWith("docs/") && !allowedDocs.has(file)) {
      addFinding({
        check: "tracked-doc-boundary",
        file,
        detail: "Only public install, boundary, streaming, and voice docs should be tracked in the source repo.",
      });
    }

    if (file === ".env" || (/^\.env\./.test(file) && file !== ".env.example")) {
      addFinding({
        check: "tracked-env-file",
        file,
        detail: "Environment files must not be tracked except .env.example.",
      });
    }
  }
}

function scanContent(files: string[]) {
  for (const file of files) {
    const absolute = path.join(repoRoot, file);
    const buffer = readFileSync(absolute);
    if (isBinary(buffer)) continue;

    const text = buffer.toString("utf8");
    for (const rule of bannedContent) {
      rule.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rule.regex.exec(text)) !== null) {
        addFinding({
          check: "private-marker",
          file,
          line: lineForIndex(text, match.index),
          detail: `Found ${rule.label}: ${match[0]}`,
        });
      }
    }
  }
}

function checkIgnore(pathname: string) {
  return spawnSync("git", ["check-ignore", "--quiet", "--no-index", pathname], {
    cwd: repoRoot,
    encoding: "utf8",
  }).status === 0;
}

function scanIgnoreRules(files: string[]) {
  if (!files.includes(".env.example")) {
    addFinding({
      check: "env-example",
      file: ".env.example",
      detail: ".env.example should be tracked for installs.",
    });
  }

  if (!checkIgnore(".env")) {
    addFinding({
      check: "env-ignore",
      file: ".env",
      detail: ".env should be ignored.",
    });
  }

  if (checkIgnore(".env.example")) {
    addFinding({
      check: "env-example-ignore",
      file: ".env.example",
      detail: ".env.example should not be ignored.",
    });
  }

  for (const pathname of [
    "artifacts/example.txt",
    "docs/qa/example.md",
    "docs/superpowers/plans/example.md",
    "docs/security/example.md",
    "planning/example.md",
    "CLAUDE.md",
    ".claude/example.json",
    ".codex/example.json",
    ".openclaw/example.json",
    ".superpowers/example.md",
  ]) {
    if (!checkIgnore(pathname)) {
      addFinding({
        check: "internal-ignore",
        file: pathname,
        detail: "Operational/local path should be ignored.",
      });
    }
  }
}

function main() {
  const files = listTrackedFiles();
  scanTrackedBoundary(files);
  scanContent(files);
  scanIgnoreRules(files);

  if (findings.length === 0) {
    console.log("Repository boundary scan passed.");
    return;
  }

  console.error(`Repository boundary scan failed with ${findings.length} finding(s):`);
  for (const finding of findings) {
    const location = finding.file
      ? `${finding.file}${finding.line ? `:${finding.line}` : ""}`
      : "(repo)";
    console.error(`- [${finding.check}] ${location} - ${finding.detail}`);
  }
  process.exitCode = 1;
}

main();
