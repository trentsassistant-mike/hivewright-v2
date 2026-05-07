import { verifyLandedState } from "../src/software-pipeline/landed-state-gate";

function optionValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const expectedBranch = optionValue("--branch") ?? "main";
const requiredAncestors = process.argv
  .flatMap((arg, index, args) => {
    if (arg.startsWith("--require-ancestor=")) return [arg.slice("--require-ancestor=".length)];
    if (arg === "--require-ancestor" && args[index + 1]) return [args[index + 1]];
    return [];
  })
  .filter(Boolean);

async function main() {
  const result = await verifyLandedState({
    expectedBranch,
    requiredAncestors,
  });

  if (!result.ok) {
    for (const failure of result.failures) {
      console.error(`[verify-landed-state] ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    `[verify-landed-state] ok: clean ${expectedBranch} worktree${requiredAncestors.length ? ` with required ancestors ${requiredAncestors.join(", ")}` : ""}`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
