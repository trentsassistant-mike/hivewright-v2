import { existsSync } from "node:fs";
import path from "node:path";
import { resolveHivewrightEnvFilePath, resolveHivewrightRuntimeRoot, pathContains } from "@/runtime/paths";
import { resolveHiveWorkspaceRoot } from "@/hives/workspace-root";

export interface RuntimePathProofEntry {
  label: "repoRoot" | "runtimeRoot" | "envFile" | "hivesWorkspaceRoot";
  path: string;
  outsideRepo: boolean;
}

export interface RuntimePathProof {
  status: "pass" | "fail";
  entries: RuntimePathProofEntry[];
  failures: string[];
}

export function findProjectRoot(start = process.cwd()): string {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, ".git")) || existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

export function buildRuntimePathProof(
  env: { [key: string]: string | undefined } = process.env,
  repoRoot = findProjectRoot(),
): RuntimePathProof {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const entries: RuntimePathProofEntry[] = [
    { label: "repoRoot", path: resolvedRepoRoot, outsideRepo: false },
  ];
  const failures: string[] = [];
  for (const [label, resolver] of [
    ["runtimeRoot", () => resolveHivewrightRuntimeRoot(env, resolvedRepoRoot)],
    ["envFile", () => resolveHivewrightEnvFilePath(env, resolvedRepoRoot)],
    ["hivesWorkspaceRoot", () => resolveHiveWorkspaceRoot(env, resolvedRepoRoot)],
  ] as const) {
    try {
      const resolved = path.resolve(resolver());
      const outsideRepo = !pathContains(resolved, resolvedRepoRoot);
      entries.push({ label, path: resolved, outsideRepo });
      if (!outsideRepo) failures.push(`${label} resolves inside repo: ${resolved}`);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      entries.push({ label, path: "<unresolved>", outsideRepo: false });
    }
  }
  return { status: failures.length === 0 ? "pass" : "fail", entries, failures };
}

export function renderRuntimePathProofMarkdown(proof: RuntimePathProof): string {
  return [
    "# Runtime Path Proof",
    "",
    `Status: ${proof.status}`,
    "",
    ...proof.entries.map((entry) => `- ${entry.label}: ${entry.path} (outside repo: ${entry.outsideRepo ? "yes" : "no"})`),
    "",
    "## Failures",
    ...(proof.failures.length === 0 ? ["- None"] : proof.failures.map((failure) => `- ${failure}`)),
  ].join("\n");
}
