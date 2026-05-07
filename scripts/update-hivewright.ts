#!/usr/bin/env tsx
import { applyUpdate, getUpdatePlan, getUpdateStatus } from "../src/system/update-runtime";

function hasFlag(flag: string) {
  return process.argv.includes(flag);
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function printStatus(status: Awaited<ReturnType<typeof getUpdateStatus>>) {
  console.log(`HiveWright ${status.currentVersion}`);
  console.log(`State: ${status.state}`);
  console.log(`Branch: ${status.branch ?? "not configured"}`);
  console.log(`Remote: ${status.remoteUrl ?? "not configured"}`);
  console.log(`Current commit: ${status.currentCommit?.slice(0, 12) ?? "unknown"}`);
  console.log(`Upstream commit: ${status.upstreamCommit?.slice(0, 12) ?? "unknown"}`);
  console.log(`Update available: ${status.updateAvailable ? "yes" : "no"}`);
  console.log(status.message);
}

async function main() {
  const json = hasFlag("--json");
  const apply = hasFlag("--apply");
  const restart = hasFlag("--restart");
  const yes = hasFlag("--yes") || hasFlag("--non-interactive");

  if (!apply) {
    const status = await getUpdateStatus({ fetch: true });
    const plan = getUpdatePlan(status, restart);
    if (json) {
      printJson({ status, plan });
    } else {
      printStatus(status);
      console.log("\nTerminal update command:");
      console.log(`  npm run hivewright:update -- --apply --yes${restart ? " --restart" : ""}`);
    }
    process.exit(status.state === "unknown" ? 1 : 0);
  }

  if (!yes) {
    console.error("Refusing to apply update without --yes. Re-run with --apply --yes after reviewing the status.");
    process.exit(2);
  }

  const result = await applyUpdate({
    restart,
    onResult: (commandResult) => {
      console.log(`\n$ ${commandResult.command}`);
      if (commandResult.stdout.trim()) console.log(commandResult.stdout.trim());
      if (commandResult.stderr.trim()) console.error(commandResult.stderr.trim());
      console.log(`exit=${commandResult.code}`);
    },
  });

  if (json) {
    printJson(result);
  }

  if (!result.plan.allowed) {
    console.error(result.plan.message);
    process.exit(1);
  }

  const failed = result.results.find((commandResult) => commandResult.code !== 0);
  if (failed) {
    console.error(`Update failed at: ${failed.command}`);
    process.exit(failed.code || 1);
  }

  console.log("HiveWright update completed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
